use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use serde::Serialize;

use crate::error::AppError;

const IGNORED_NAMES: &[&str] = &[
    ".git",
    ".prometheus",
    "coverage",
    "dist",
    "node_modules",
    "target",
];

const DEFAULT_READ_MAX_BYTES: usize = 64 * 1024;
const DEFAULT_WRITE_MAX_BYTES: usize = 1024 * 1024;
const DEFAULT_SEARCH_MAX_RESULTS: usize = 100;

#[derive(Clone)]
pub struct WorkspaceService {
    root: PathBuf,
    root_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNode {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct TextFileRead {
    pub content: String,
    pub truncated: bool,
}

#[derive(Clone, Debug)]
pub struct TextFileWrite {
    pub path: String,
    pub bytes: usize,
}

impl WorkspaceService {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, AppError> {
        let root = fs::canonicalize(root.as_ref()).map_err(|error| {
            AppError::configuration(format!("Invalid workspace root: {error}"))
        })?;
        if !root.is_dir() {
            return Err(AppError::configuration(
                "Workspace root must be a directory",
            ));
        }
        let root_name = root
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string());
        Ok(Self { root, root_name })
    }

    pub fn root_name(&self) -> &str {
        &self.root_name
    }

    pub fn root_path(&self) -> &Path {
        &self.root
    }

    pub fn list(&self, relative_path: &str) -> Result<Vec<WorkspaceNode>, AppError> {
        let resolved = self.resolve_existing(relative_path)?;
        if !resolved.is_dir() {
            return Err(AppError::invalid_request("Path is not a directory"));
        }

        let mut nodes = Vec::new();
        for entry in fs::read_dir(&resolved).map_err(|error| {
            AppError::configuration(format!("Unable to read workspace directory: {error}"))
        })? {
            let entry = entry.map_err(|error| {
                AppError::configuration(format!("Unable to read workspace entry: {error}"))
            })?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if IGNORED_NAMES.contains(&name.as_str()) {
                continue;
            }
            let file_type = entry.file_type().map_err(|error| {
                AppError::configuration(format!("Unable to inspect workspace entry: {error}"))
            })?;
            if file_type.is_symlink() {
                continue;
            }
            let kind = if file_type.is_dir() {
                "directory"
            } else if file_type.is_file() {
                "file"
            } else {
                continue;
            };
            let absolute = entry.path();
            let relative = absolute
                .strip_prefix(&self.root)
                .map_err(|_| AppError::workspace_boundary(absolute.display().to_string()))?;
            nodes.push(WorkspaceNode {
                name,
                path: relative_to_posix(relative),
                kind,
            });
        }

        nodes.sort_by(|left, right| match (left.kind, right.kind) {
            ("directory", "file") => std::cmp::Ordering::Less,
            ("file", "directory") => std::cmp::Ordering::Greater,
            _ => left
                .name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.name.cmp(&right.name)),
        });
        Ok(nodes)
    }

    pub fn resolve_directory(&self, relative_path: &str) -> Result<PathBuf, AppError> {
        let resolved = self.resolve_existing(relative_path)?;
        if !resolved.is_dir() {
            return Err(AppError::invalid_request("Path is not a directory"));
        }
        Ok(resolved)
    }

    pub fn read_text_file(
        &self,
        relative_path: &str,
        max_bytes: Option<usize>,
    ) -> Result<TextFileRead, AppError> {
        let max_bytes = max_bytes.unwrap_or(DEFAULT_READ_MAX_BYTES);
        let resolved = self.resolve_existing(relative_path)?;
        if !resolved.is_file() {
            return Err(AppError::invalid_request("Path is not a file"));
        }
        let bytes = fs::read(&resolved).map_err(|error| {
            AppError::configuration(format!("Unable to read workspace file: {error}"))
        })?;
        if bytes.iter().take(8_192).any(|byte| *byte == 0) {
            return Err(AppError::invalid_request(format!(
                "Binary file rejected: {relative_path}"
            )));
        }
        let truncated = bytes.len() > max_bytes;
        let content = String::from_utf8_lossy(&bytes[..bytes.len().min(max_bytes)]).into_owned();
        Ok(TextFileRead { content, truncated })
    }

    pub fn write_text_file(
        &self,
        relative_path: &str,
        content: &str,
        max_bytes: Option<usize>,
    ) -> Result<TextFileWrite, AppError> {
        let max_bytes = max_bytes.unwrap_or(DEFAULT_WRITE_MAX_BYTES);
        let bytes = content.len();
        if bytes > max_bytes {
            return Err(AppError::invalid_request(format!(
                "Write content exceeds {max_bytes} bytes"
            )));
        }
        if Path::new(relative_path).is_absolute()
            || relative_path
                .split(['/', '\\'])
                .any(|segment| segment == "..")
        {
            return Err(AppError::workspace_boundary(relative_path));
        }

        let mut lexical = self.root.clone();
        for segment in relative_path.split(['/', '\\']) {
            if segment.is_empty() || segment == "." {
                continue;
            }
            if segment == ".." {
                return Err(AppError::workspace_boundary(relative_path));
            }
            lexical.push(segment);
        }
        self.assert_contained(&lexical)?;

        let parent = lexical
            .parent()
            .ok_or_else(|| AppError::workspace_boundary(relative_path))?;
        let real_parent = fs::canonicalize(parent).map_err(|_| AppError::path_not_found())?;
        self.assert_contained(&real_parent)?;
        let target = real_parent.join(
            lexical
                .file_name()
                .ok_or_else(|| AppError::invalid_request("Invalid write path"))?,
        );
        self.assert_contained(&target)?;

        if target.exists() {
            let metadata = fs::symlink_metadata(&target).map_err(|error| {
                AppError::configuration(format!("Unable to inspect write target: {error}"))
            })?;
            if metadata.file_type().is_symlink() {
                return Err(AppError::invalid_request(
                    "Symbolic link write targets are not supported",
                ));
            }
            if !metadata.is_file() {
                return Err(AppError::invalid_request("Write target is not a file"));
            }
        }

        fs::write(&target, content.as_bytes()).map_err(|error| {
            AppError::configuration(format!("Unable to write workspace file: {error}"))
        })?;
        let relative = target
            .strip_prefix(&self.root)
            .map_err(|_| AppError::workspace_boundary(target.display().to_string()))?;
        Ok(TextFileWrite {
            path: relative_to_posix(relative),
            bytes,
        })
    }

    pub fn search_text(
        &self,
        query: &str,
        relative_path: &str,
        max_results: Option<usize>,
    ) -> Result<Vec<WorkspaceSearchMatch>, AppError> {
        let max_results = max_results.unwrap_or(DEFAULT_SEARCH_MAX_RESULTS);
        let start = self.resolve_existing(relative_path)?;
        let needle = query.to_lowercase();
        let mut matches = Vec::new();
        self.visit_search(&start, &needle, max_results, &mut matches)?;
        Ok(matches)
    }

    fn visit_search(
        &self,
        path: &Path,
        needle: &str,
        max_results: usize,
        matches: &mut Vec<WorkspaceSearchMatch>,
    ) -> Result<(), AppError> {
        if matches.len() >= max_results {
            return Ok(());
        }
        let metadata = fs::metadata(path).map_err(|error| {
            AppError::configuration(format!("Unable to inspect search path: {error}"))
        })?;
        if metadata.is_file() {
            if metadata.len() > 1024 * 1024 {
                return Ok(());
            }
            let bytes = fs::read(path).map_err(|error| {
                AppError::configuration(format!("Unable to read search file: {error}"))
            })?;
            if bytes.iter().take(8_192).any(|byte| *byte == 0) {
                return Ok(());
            }
            let text = String::from_utf8_lossy(&bytes);
            for (index, line) in text.split('\n').enumerate() {
                let line = line.trim_end_matches('\r');
                if !line.to_lowercase().contains(needle) {
                    continue;
                }
                let relative = path
                    .strip_prefix(&self.root)
                    .map_err(|_| AppError::workspace_boundary(path.display().to_string()))?;
                let preview: String = line.chars().take(300).collect();
                matches.push(WorkspaceSearchMatch {
                    path: relative_to_posix(relative),
                    line: index + 1,
                    text: preview,
                });
                if matches.len() >= max_results {
                    return Ok(());
                }
            }
            return Ok(());
        }
        if !metadata.is_dir() {
            return Ok(());
        }
        let mut entries: Vec<_> = fs::read_dir(path)
            .map_err(|error| {
                AppError::configuration(format!("Unable to read search directory: {error}"))
            })?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if IGNORED_NAMES.contains(&name.as_str()) {
                continue;
            }
            let file_type = entry.file_type().map_err(|error| {
                AppError::configuration(format!("Unable to inspect search entry: {error}"))
            })?;
            if file_type.is_symlink() {
                continue;
            }
            self.visit_search(&entry.path(), needle, max_results, matches)?;
            if matches.len() >= max_results {
                return Ok(());
            }
        }
        Ok(())
    }

    fn resolve_existing(&self, relative_path: &str) -> Result<PathBuf, AppError> {
        if relative_path
            .split(['/', '\\'])
            .any(|segment| segment == "..")
        {
            return Err(AppError::workspace_boundary(relative_path));
        }
        if Path::new(relative_path).is_absolute() {
            return Err(AppError::workspace_boundary(relative_path));
        }

        let joined = if relative_path.is_empty() {
            self.root.clone()
        } else {
            let mut path = self.root.clone();
            for segment in relative_path.split(['/', '\\']) {
                if segment.is_empty() || segment == "." {
                    continue;
                }
                if segment == ".." {
                    return Err(AppError::workspace_boundary(relative_path));
                }
                path.push(segment);
            }
            path
        };

        if !joined.exists() {
            return Err(AppError::path_not_found());
        }

        let resolved = fs::canonicalize(&joined).map_err(|_| AppError::path_not_found())?;
        self.assert_contained(&resolved)?;
        Ok(resolved)
    }

    fn assert_contained(&self, path: &Path) -> Result<(), AppError> {
        if path == self.root || path.starts_with(&self.root) {
            Ok(())
        } else {
            Err(AppError::workspace_boundary(path.display().to_string()))
        }
    }
}

fn relative_to_posix(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}
