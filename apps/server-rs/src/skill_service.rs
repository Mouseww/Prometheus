use std::path::{Path, PathBuf};

use crate::{
    error::AppError,
    models::SkillSummary,
};

#[derive(Clone)]
pub struct SkillService {
    roots: Vec<PathBuf>,
}

impl SkillService {
    pub fn new(workspace_root: impl AsRef<Path>) -> Self {
        let workspace_root = workspace_root.as_ref().to_path_buf();
        Self {
            roots: vec![
                workspace_root.join(".prometheus").join("skills"),
                workspace_root.join("skills"),
            ],
        }
    }

    pub fn list(&self) -> Result<Vec<SkillSummary>, AppError> {
        let mut skills = Vec::new();
        for root in &self.roots {
            if !root.is_dir() {
                continue;
            }
            let entries = std::fs::read_dir(root).map_err(|error| {
                AppError::invalid_request(format!("Unable to read skills root: {error}"))
            })?;
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let skill_file = path.join("SKILL.md");
                if !skill_file.is_file() {
                    continue;
                }
                let folder = path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "skill".to_owned());
                let content = std::fs::read_to_string(&skill_file).map_err(|error| {
                    AppError::invalid_request(format!("Unable to read skill: {error}"))
                })?;
                let (name, description) = parse_skill_frontmatter(&content, &folder);
                let id = folder;
                skills.push(SkillSummary {
                    id: id.clone(),
                    name,
                    description,
                    path: skill_file.display().to_string(),
                });
            }
        }
        skills.sort_by(|left, right| left.id.cmp(&right.id));
        skills.dedup_by(|left, right| left.id == right.id);
        Ok(skills)
    }

    pub fn read(&self, skill_id: &str) -> Result<String, AppError> {
        let skill_id = skill_id.trim();
        if skill_id.is_empty()
            || skill_id.contains('/')
            || skill_id.contains('\\')
            || skill_id.contains("..")
        {
            return Err(AppError::invalid_request("skill id is invalid"));
        }
        for root in &self.roots {
            let skill_file = root.join(skill_id).join("SKILL.md");
            if skill_file.is_file() {
                return std::fs::read_to_string(skill_file).map_err(|error| {
                    AppError::invalid_request(format!("Unable to read skill: {error}"))
                });
            }
        }
        Err(AppError::configuration_not_found(format!(
            "Skill not found: {skill_id}"
        )))
    }

    pub fn prompt_section(&self) -> Result<String, AppError> {
        let skills = self.list()?;
        if skills.is_empty() {
            return Ok(String::new());
        }
        let mut lines = vec![
            "## Available Skills".to_owned(),
            "Use the read_skill tool with a skill id to load full instructions when a skill is relevant.".to_owned(),
        ];
        for skill in skills {
            lines.push(format!(
                "- {} (`{}`): {}",
                skill.name, skill.id, skill.description
            ));
        }
        Ok(lines.join("\n"))
    }
}

fn parse_skill_frontmatter(content: &str, fallback_name: &str) -> (String, String) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        let description = first_paragraph(trimmed);
        return (fallback_name.to_owned(), description);
    }
    let rest = &trimmed[3..];
    let Some(end) = rest.find("\n---") else {
        let description = first_paragraph(trimmed);
        return (fallback_name.to_owned(), description);
    };
    let front = &rest[..end];
    let body = rest[end + 4..].trim();
    let mut name = fallback_name.to_owned();
    let mut description = String::new();
    for line in front.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("name:") {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                name = value.to_owned();
            }
        } else if let Some(value) = line.strip_prefix("description:") {
            description = value.trim().trim_matches('"').trim_matches('\'').to_owned();
        }
    }
    if description.is_empty() {
        description = first_paragraph(body);
    }
    (name, description)
}

fn first_paragraph(content: &str) -> String {
    let text = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    if text.chars().count() <= 240 {
        text
    } else {
        text.chars().take(240).collect::<String>() + "…"
    }
}
