use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

use crate::error::AppError;

const BRANCH_PREFIX: &str = "prometheus/team/";
const MAX_PATCH_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct CreatedWorktree {
    pub repo_root: PathBuf,
    pub worktree_root: PathBuf,
    pub workspace_root: PathBuf,
    pub branch_name: String,
    pub base_commit: String,
}

#[derive(Clone, Debug)]
pub struct WorktreeReview {
    pub status: String,
    pub changed_paths: Vec<String>,
    pub disallowed_paths: Vec<String>,
    pub patch_bytes: usize,
}

#[derive(Clone, Debug)]
pub struct WorktreeApplyResult {
    pub status: String,
    pub changed_paths: Vec<String>,
    pub conflict_paths: Vec<String>,
    pub patch_bytes: usize,
}

#[derive(Clone, Debug)]
pub struct WorktreeCleanupResult {
    pub removed: bool,
    pub branch_deleted: bool,
}

#[derive(Clone)]
pub struct GitWorktreeManager {
    workspace_root: PathBuf,
    storage_root: PathBuf,
}

struct PreparedChanges {
    status: String,
    changed_paths: Vec<String>,
    disallowed_paths: Vec<String>,
    patch_bytes: usize,
    patch: Vec<u8>,
}

struct ChangedPath {
    git_path: String,
    display_path: String,
}

impl GitWorktreeManager {
    pub fn new(workspace_root: impl AsRef<Path>, storage_root: impl AsRef<Path>) -> Result<Self, AppError> {
        let workspace_root = canonical_directory(workspace_root.as_ref(), "workspace root")?;
        let storage_root = storage_root.as_ref().to_path_buf();
        Ok(Self {
            workspace_root,
            storage_root,
        })
    }

    pub fn create(&self, task_id: &str, label: &str) -> Result<CreatedWorktree, AppError> {
        if uuid::Uuid::parse_str(task_id).is_err() {
            return Err(git_error("Task ID must be a UUID"));
        }
        let repo_root = self.repo_root(&self.workspace_root)?;
        let base_commit = git_text(&repo_root, &["rev-parse", "--verify", "HEAD^{commit}"])?;
        if !is_sha1(&base_commit) {
            return Err(git_error(
                "Git repository does not have a usable HEAD commit",
            ));
        }
        let workspace_relative = relative_path(&repo_root, &self.workspace_root)?;
        if is_outside(&workspace_relative) {
            return Err(git_error(
                "Workspace root must be inside the Git repository",
            ));
        }

        fs::create_dir_all(&self.storage_root).map_err(|error| {
            git_error(format!("Unable to create worktree storage root: {error}"))
        })?;
        let storage_root = canonical_directory(&self.storage_root, "worktree storage root")?;
        let target = storage_root.join(format!("{}-{task_id}", sanitize_label(label)));
        if !is_contained(&storage_root, &target) {
            return Err(git_error(
                "Worktree target escapes the configured storage root",
            ));
        }
        if target.exists() {
            return Err(git_error("Worktree target already exists"));
        }

        let branch_name = format!("{BRANCH_PREFIX}{task_id}");
        git_buffer(
            &repo_root,
            &[
                "worktree",
                "add",
                "-b",
                &branch_name,
                &path_str(&target),
                &base_commit,
            ],
            None,
        )?;
        let worktree_root = canonical_directory(&target, "created worktree")?;
        let child_workspace = if workspace_relative.as_os_str().is_empty() {
            worktree_root.clone()
        } else {
            worktree_root.join(&workspace_relative)
        };
        let workspace_root = canonical_directory(&child_workspace, "created child workspace")?;
        Ok(CreatedWorktree {
            repo_root,
            worktree_root,
            workspace_root,
            branch_name,
            base_commit,
        })
    }

    pub fn review(
        &self,
        worktree_root: &Path,
        base_commit: &str,
        allowed_paths: &[String],
    ) -> Result<WorktreeReview, AppError> {
        let prepared = self.prepare(worktree_root, base_commit, allowed_paths)?;
        Ok(WorktreeReview {
            status: prepared.status,
            changed_paths: prepared.changed_paths,
            disallowed_paths: prepared.disallowed_paths,
            patch_bytes: prepared.patch_bytes,
        })
    }

    pub fn apply(
        &self,
        worktree_root: &Path,
        base_commit: &str,
        allowed_paths: &[String],
    ) -> Result<WorktreeApplyResult, AppError> {
        let prepared = self.prepare(worktree_root, base_commit, allowed_paths)?;
        if prepared.status == "no_changes" {
            return Ok(WorktreeApplyResult {
                status: "no_changes".into(),
                changed_paths: Vec::new(),
                conflict_paths: Vec::new(),
                patch_bytes: 0,
            });
        }
        if prepared.status == "rejected" {
            return Ok(WorktreeApplyResult {
                status: "rejected".into(),
                changed_paths: prepared.changed_paths,
                conflict_paths: prepared.disallowed_paths,
                patch_bytes: 0,
            });
        }

        let parent_repo_root = self.repo_root(&self.workspace_root)?;
        let worktree_root = canonical_directory(worktree_root, "worktree root")?;
        self.assert_same_repository(&parent_repo_root, &worktree_root)?;
        if !try_git(
            &parent_repo_root,
            &["apply", "--check", "--binary", "--whitespace=nowarn", "-"],
            Some(&prepared.patch),
        ) {
            return Ok(WorktreeApplyResult {
                status: "conflicted".into(),
                changed_paths: prepared.changed_paths.clone(),
                conflict_paths: prepared.changed_paths,
                patch_bytes: prepared.patch_bytes,
            });
        }
        if !try_git(
            &parent_repo_root,
            &["apply", "--binary", "--whitespace=nowarn", "-"],
            Some(&prepared.patch),
        ) {
            return Ok(WorktreeApplyResult {
                status: "conflicted".into(),
                changed_paths: prepared.changed_paths.clone(),
                conflict_paths: prepared.changed_paths,
                patch_bytes: prepared.patch_bytes,
            });
        }
        Ok(WorktreeApplyResult {
            status: "applied".into(),
            changed_paths: prepared.changed_paths,
            conflict_paths: Vec::new(),
            patch_bytes: prepared.patch_bytes,
        })
    }

    pub fn cleanup(
        &self,
        worktree_root: &Path,
        branch_name: &str,
        _outcome: &str,
    ) -> Result<WorktreeCleanupResult, AppError> {
        if !branch_name.starts_with(BRANCH_PREFIX) {
            return Err(git_error(
                "Refusing to delete a non-Prometheus team branch",
            ));
        }
        if !worktree_root.exists() {
            return Ok(WorktreeCleanupResult {
                removed: false,
                branch_deleted: false,
            });
        }
        let storage_root = canonical_directory(&self.storage_root, "worktree storage root")?;
        let worktree_root = canonical_directory(worktree_root, "worktree root")?;
        if !is_contained(&storage_root, &worktree_root) {
            return Err(git_error(
                "Refusing to cleanup outside the configured worktree storage root",
            ));
        }
        let repo_root = self.repo_root(&self.workspace_root)?;
        self.assert_same_repository(&repo_root, &worktree_root)?;
        let checked_out = git_text(
            &worktree_root,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        )?;
        if checked_out != branch_name {
            return Err(git_error(
                "Worktree branch does not match the cleanup request",
            ));
        }
        git_buffer(
            &repo_root,
            &["worktree", "remove", "--force", &path_str(&worktree_root)],
            None,
        )?;
        let branch_ref = format!("refs/heads/{branch_name}");
        let branch_exists = try_git(&repo_root, &["show-ref", "--verify", "--quiet", &branch_ref], None);
        if branch_exists {
            let _ = git_buffer(&repo_root, &["branch", "-D", branch_name], None);
        }
        Ok(WorktreeCleanupResult {
            removed: true,
            branch_deleted: branch_exists,
        })
    }

    fn prepare(
        &self,
        worktree_root_input: &Path,
        base_commit: &str,
        allowed_paths: &[String],
    ) -> Result<PreparedChanges, AppError> {
        if !is_sha1(base_commit) {
            return Err(git_error("Invalid base commit"));
        }
        let worktree_root = canonical_directory(worktree_root_input, "worktree root")?;
        let parent_repo_root = self.repo_root(&self.workspace_root)?;
        self.assert_same_repository(&parent_repo_root, &worktree_root)?;
        if !try_git(
            &worktree_root,
            &["cat-file", "-e", &format!("{base_commit}^{{commit}}")],
            None,
        ) {
            return Err(git_error(
                "Base commit is not available in the worktree repository",
            ));
        }

        let changed = self.collect_changed_paths(&worktree_root, base_commit)?;
        let mut changed_paths = changed
            .iter()
            .map(|item| item.display_path.clone())
            .collect::<Vec<_>>();
        changed_paths.sort_by_key(|a| path_key(a));
        if changed.is_empty() {
            return Ok(PreparedChanges {
                status: "no_changes".into(),
                changed_paths: Vec::new(),
                disallowed_paths: Vec::new(),
                patch_bytes: 0,
                patch: Vec::new(),
            });
        }
        let scopes = allowed_paths
            .iter()
            .map(|path| normalize_scope(path))
            .collect::<Result<Vec<_>, _>>()?;
        let mut disallowed_paths = changed
            .iter()
            .filter(|entry| !scopes.iter().any(|scope| path_belongs_to_scope(&entry.display_path, scope)))
            .map(|entry| entry.display_path.clone())
            .collect::<Vec<_>>();
        disallowed_paths.sort_by_key(|a| path_key(a));
        if !disallowed_paths.is_empty() {
            return Ok(PreparedChanges {
                status: "rejected".into(),
                changed_paths,
                disallowed_paths,
                patch_bytes: 0,
                patch: Vec::new(),
            });
        }

        let git_paths = changed
            .iter()
            .map(|entry| entry.git_path.clone())
            .collect::<Vec<_>>();
        git_buffer(
            &worktree_root,
            &["reset", "-q", base_commit, "--"],
            None,
        )?;
        let mut add_args = vec![
            "add".to_owned(),
            "-A".to_owned(),
            "--".to_owned(),
        ];
        add_args.extend(git_paths);
        let patch_result = (|| {
            git_buffer_owned(&worktree_root, &add_args, None)?;
            git_buffer(
                &worktree_root,
                &["diff", "--cached", "--binary", base_commit, "--"],
                None,
            )
        })();
        let _ = git_buffer(
            &worktree_root,
            &["reset", "-q", "HEAD", "--"],
            None,
        );
        let patch = patch_result?;
        if patch.len() > MAX_PATCH_BYTES {
            return Err(git_error(format!(
                "Patch exceeds {MAX_PATCH_BYTES} bytes"
            )));
        }
        if patch.is_empty() {
            return Ok(PreparedChanges {
                status: "no_changes".into(),
                changed_paths: Vec::new(),
                disallowed_paths: Vec::new(),
                patch_bytes: 0,
                patch,
            });
        }
        Ok(PreparedChanges {
            status: "pending".into(),
            changed_paths,
            disallowed_paths: Vec::new(),
            patch_bytes: patch.len(),
            patch,
        })
    }

    fn collect_changed_paths(
        &self,
        worktree_root: &Path,
        base_commit: &str,
    ) -> Result<Vec<ChangedPath>, AppError> {
        let tracked = split_nul(&git_buffer(
            worktree_root,
            &[
                "-c",
                "core.quotePath=false",
                "diff",
                "--name-only",
                "--no-renames",
                "-z",
                base_commit,
                "--",
            ],
            None,
        )?);
        let untracked = split_nul(&git_buffer(
            worktree_root,
            &[
                "-c",
                "core.quotePath=false",
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            None,
        )?);
        let repo_root = self.repo_root(&self.workspace_root)?;
        let workspace_relative = relative_path(&repo_root, &self.workspace_root)?;
        let workspace_prefix = if workspace_relative.as_os_str().is_empty() {
            String::new()
        } else {
            normalize_git_path(&workspace_relative.to_string_lossy())?
        };
        let mut unique = std::collections::BTreeMap::new();
        for raw in tracked.into_iter().chain(untracked) {
            let git_path = normalize_git_path(&raw)?;
            let display_path = to_workspace_display_path(&git_path, &workspace_prefix);
            unique.insert(path_key(&git_path), ChangedPath { git_path, display_path });
        }
        Ok(unique.into_values().collect())
    }

    fn repo_root(&self, cwd: &Path) -> Result<PathBuf, AppError> {
        let result = try_git_output(cwd, &["rev-parse", "--show-toplevel"], None);
        let Some(stdout) = result else {
            return Err(git_error("Workspace is not inside a Git repository"));
        };
        let text = String::from_utf8_lossy(&stdout).trim().to_owned();
        canonical_directory(Path::new(&text), "git repository root")
    }

    fn assert_same_repository(&self, parent: &Path, worktree: &Path) -> Result<(), AppError> {
        let parent_common = git_common_directory(parent)?;
        let worktree_common = git_common_directory(worktree)?;
        if path_key(&path_str(&parent_common)) != path_key(&path_str(&worktree_common)) {
            return Err(git_error(
                "Worktree does not belong to the parent repository",
            ));
        }
        Ok(())
    }
}

fn git_common_directory(cwd: &Path) -> Result<PathBuf, AppError> {
    let text = git_text(cwd, &["rev-parse", "--git-common-dir"])?;
    let path = if Path::new(&text).is_absolute() {
        PathBuf::from(text)
    } else {
        cwd.join(text)
    };
    canonical_directory(&path, "git common directory")
}

fn git_text(cwd: &Path, args: &[&str]) -> Result<String, AppError> {
    let bytes = git_buffer(cwd, args, None)?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_owned())
}

fn git_buffer(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>, AppError> {
    let owned = args.iter().map(|item| (*item).to_owned()).collect::<Vec<_>>();
    git_buffer_owned(cwd, &owned, stdin)
}

fn git_buffer_owned(
    cwd: &Path,
    args: &[String],
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, AppError> {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command.spawn().map_err(|error| {
        git_error(format!("Unable to spawn git: {error}"))
    })?;
    if let Some(bytes) = stdin
        && let Some(mut handle) = child.stdin.take()
    {
        handle.write_all(bytes).map_err(|error| {
            git_error(format!("Unable to write git stdin: {error}"))
        })?;
    }
    let output = child.wait_with_output().map_err(|error| {
        git_error(format!("Unable to wait for git: {error}"))
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(git_error(format!(
            "git {} failed: {}",
            args.join(" "),
            stderr.trim()
        )));
    }
    Ok(output.stdout)
}

fn try_git(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> bool {
    try_git_output(cwd, args, stdin).is_some()
}

fn try_git_output(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> Option<Vec<u8>> {
    git_buffer(cwd, args, stdin).ok()
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, AppError> {
    let canonical = fs::canonicalize(path).map_err(|_| {
        git_error(format!(
            "{label} must be an existing directory: {}",
            path.display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(git_error(format!(
            "{label} must be a directory: {}",
            path.display()
        )));
    }
    Ok(canonical)
}

fn relative_path(root: &Path, child: &Path) -> Result<PathBuf, AppError> {
    let root = fs::canonicalize(root).map_err(|error| git_error(error.to_string()))?;
    let child = fs::canonicalize(child).map_err(|error| git_error(error.to_string()))?;
    pathdiff_simple(&root, &child).ok_or_else(|| git_error("Unable to compute relative path"))
}

fn pathdiff_simple(root: &Path, child: &Path) -> Option<PathBuf> {
    let root_components = root.components().collect::<Vec<_>>();
    let child_components = child.components().collect::<Vec<_>>();
    if child_components.len() < root_components.len() {
        return None;
    }
    if root_components
        .iter()
        .zip(child_components.iter())
        .any(|(a, b)| path_key(&component_str(a)) != path_key(&component_str(b)))
    {
        return None;
    }
    Some(child_components[root_components.len()..].iter().collect())
}

fn component_str(component: &Component<'_>) -> String {
    component.as_os_str().to_string_lossy().into_owned()
}

fn is_outside(relative: &Path) -> bool {
    relative
        .components()
        .any(|component| matches!(component, Component::ParentDir))
        || relative.is_absolute()
}

fn is_contained(root: &Path, candidate: &Path) -> bool {
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    let candidate = if candidate.exists() {
        fs::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf())
    } else if let Some(parent) = candidate.parent() {
        let parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        parent.join(candidate.file_name().unwrap_or_default())
    } else {
        candidate.to_path_buf()
    };
    pathdiff_simple(&root, &candidate)
        .map(|rel| !rel.as_os_str().is_empty() && !is_outside(&rel))
        .unwrap_or(false)
}

fn split_nul(value: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(value)
        .split('\0')
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

fn normalize_git_path(value: &str) -> Result<String, AppError> {
    let normalized = value
        .replace('\\', "/")
        .trim_start_matches("./")
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || (normalized.len() >= 2 && normalized.as_bytes()[1] == b':')
    {
        return Err(git_error(format!("Unsafe Git path: {value}")));
    }
    let segments = normalized.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| *segment == "." || *segment == ".." || segment.is_empty())
    {
        return Err(git_error(format!("Unsafe Git path: {value}")));
    }
    Ok(normalized)
}

fn to_workspace_display_path(git_path: &str, workspace_prefix: &str) -> String {
    if workspace_prefix.is_empty() {
        return git_path.to_owned();
    }
    let prefix = format!("{workspace_prefix}/");
    if path_key(git_path).starts_with(&path_key(&prefix)) {
        git_path[workspace_prefix.len() + 1..].to_owned()
    } else {
        format!("@repo/{git_path}")
    }
}

fn normalize_scope(value: &str) -> Result<String, AppError> {
    let normalized = value
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned();
    if normalized == "." {
        return Ok(normalized);
    }
    normalize_git_path(&normalized)
}

fn path_belongs_to_scope(path: &str, scope: &str) -> bool {
    if path.starts_with("@repo/") {
        return false;
    }
    if scope == "." {
        return true;
    }
    let candidate = path_key(path);
    let owner = path_key(scope);
    candidate == owner || candidate.starts_with(&format!("{owner}/"))
}

fn sanitize_label(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(48)
        .collect::<String>();
    let candidate = if normalized.is_empty() {
        "agent".to_owned()
    } else {
        normalized
    };
    let reserved = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    if reserved
        .iter()
        .any(|item| candidate.eq_ignore_ascii_case(item))
    {
        format!("{candidate}-agent")
    } else {
        candidate
    }
}

fn path_key(value: &str) -> String {
    value.replace('\\', "/").to_ascii_lowercase()
}

fn path_str(path: &Path) -> String {
    strip_extended_path_prefix(&path.to_string_lossy())
}

fn strip_extended_path_prefix(value: &str) -> String {
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        value.to_owned()
    }
}

fn is_sha1(value: &str) -> bool {
    value.len() == 40 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn git_error(message: impl Into<String>) -> AppError {
    AppError::invalid_request(message.into())
}
