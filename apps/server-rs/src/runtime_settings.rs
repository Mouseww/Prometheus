use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub projects: Vec<RuntimeProject>,
    #[serde(default)]
    pub active_project_id: Option<String>,
}

impl RuntimeSettings {
    pub fn load(path: &Path) -> Result<Self, AppError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = fs::read_to_string(path).map_err(|error| {
            AppError::configuration(format!("Unable to read runtime settings: {error}"))
        })?;
        if raw.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str(&raw).map_err(|error| {
            AppError::configuration(format!("Invalid runtime settings JSON: {error}"))
        })
    }

    pub fn save(&self, path: &Path) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                AppError::configuration(format!("Unable to create runtime settings directory: {error}"))
            })?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|error| {
            AppError::configuration(format!("Unable to encode runtime settings: {error}"))
        })?;
        fs::write(path, raw).map_err(|error| {
            AppError::configuration(format!("Unable to write runtime settings: {error}"))
        })?;
        Ok(())
    }

    pub fn upsert_project(&mut self, path: &Path) -> Result<RuntimeProject, AppError> {
        let absolute = path.canonicalize().map_err(|error| {
            AppError::invalid_request(format!("Invalid project path: {error}"))
        })?;
        if !absolute.is_dir() {
            return Err(AppError::invalid_request("Project path must be a directory"));
        }
        let absolute_str = absolute.to_string_lossy().into_owned();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        if let Some(existing) = self
            .projects
            .iter_mut()
            .find(|project| PathBuf::from(&project.path) == absolute)
        {
            existing.last_opened_at = now.clone();
            let project = existing.clone();
            self.active_project_id = Some(project.id.clone());
            self.workspace_root = Some(absolute_str);
            return Ok(project);
        }
        let name = absolute
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| absolute_str.clone());
        let project = RuntimeProject {
            id: Uuid::new_v4().to_string(),
            name,
            path: absolute_str.clone(),
            last_opened_at: now,
        };
        self.projects.insert(0, project.clone());
        self.active_project_id = Some(project.id.clone());
        self.workspace_root = Some(absolute_str);
        Ok(project)
    }

    pub fn remove_project(&mut self, project_id: &str) -> bool {
        let before = self.projects.len();
        self.projects.retain(|project| project.id != project_id);
        if self.active_project_id.as_deref() == Some(project_id) {
            self.active_project_id = self.projects.first().map(|project| project.id.clone());
            self.workspace_root = self
                .projects
                .first()
                .map(|project| project.path.clone());
        }
        before != self.projects.len()
    }

    pub fn find_project(&self, project_id: &str) -> Option<&RuntimeProject> {
        self.projects.iter().find(|project| project.id == project_id)
    }
}

pub fn default_runtime_file(data_file: &Path) -> PathBuf {
    data_file
        .parent()
        .map(|parent| parent.join("runtime.json"))
        .unwrap_or_else(|| PathBuf::from("runtime.json"))
}
