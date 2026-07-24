use chrono::{SecondsFormat, Utc};
use sqlx::FromRow;
use url::Url;
use uuid::Uuid;

use crate::{
    database::Database,
    error::AppError,
    models::{
        AgentProfile, CreateAgentInput, CreatePermissionRuleInput, CreateProviderInput,
        PermissionRule, Provider, UpdateAgentInput, UpdateProviderInput,
    },
    secret_vault::SecretVault,
};

const PROVIDER_KINDS: &[&str] = &["openai", "openai_compatible", "anthropic", "gemini"];
const RULE_EFFECTS: &[&str] = &["deny", "ask", "allow"];

#[derive(Clone)]
pub struct ConfigRepository {
    database: Database,
    vault: SecretVault,
}

impl ConfigRepository {
    pub fn new(database: Database, vault: SecretVault) -> Self {
        Self { database, vault }
    }

    pub async fn list_providers(&self) -> Result<Vec<Provider>, AppError> {
        let rows = sqlx::query_as::<_, ProviderRow>(
            r#"
            SELECT id, name, kind, base_url, default_model, encrypted_api_key, created_at, updated_at
            FROM providers
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(self.database.pool())
        .await?;
        Ok(rows.into_iter().map(Provider::from).collect())
    }

    pub async fn get_provider(&self, id: &str) -> Result<Option<Provider>, AppError> {
        let row = sqlx::query_as::<_, ProviderRow>(
            r#"
            SELECT id, name, kind, base_url, default_model, encrypted_api_key, created_at, updated_at
            FROM providers WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await?;
        Ok(row.map(Provider::from))
    }

    pub async fn get_provider_runtime(
        &self,
        id: &str,
    ) -> Result<Option<crate::models::RuntimeProvider>, AppError> {
        let row = sqlx::query_as::<_, ProviderRow>(
            r#"
            SELECT id, name, kind, base_url, default_model, encrypted_api_key, created_at, updated_at
            FROM providers WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let api_key = self.vault.decrypt(&row.encrypted_api_key)?;
        Ok(Some(crate::models::RuntimeProvider {
            id: row.id,
            kind: row.kind,
            base_url: row.base_url,
            api_key,
        }))
    }

    pub async fn create_provider(&self, input: CreateProviderInput) -> Result<Provider, AppError> {
        let name = validate_name(&input.name, 80, "name")?;
        let kind = validate_provider_kind(&input.kind)?;
        let default_model = validate_name(&input.default_model, 160, "defaultModel")?;
        let api_key = input.api_key.trim();
        if api_key.is_empty() || api_key.chars().count() > 4096 {
            return Err(AppError::invalid_request(
                "apiKey must contain between 1 and 4096 characters",
            ));
        }
        let base_url = normalize_base_url(input.base_url.as_deref(), kind)?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let encrypted = self.vault.encrypt(api_key)?;
        sqlx::query(
            r#"
            INSERT INTO providers (
              id, name, kind, base_url, default_model, encrypted_api_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(name)
        .bind(kind)
        .bind(&base_url)
        .bind(default_model)
        .bind(encrypted)
        .bind(&now)
        .bind(&now)
        .execute(self.database.pool())
        .await?;
        self.get_provider(&id)
            .await?
            .ok_or_else(|| AppError::configuration("Provider insert disappeared"))
    }

    pub async fn update_provider(
        &self,
        id: &str,
        input: UpdateProviderInput,
    ) -> Result<Provider, AppError> {
        let existing = sqlx::query_as::<_, ProviderRow>(
            r#"
            SELECT id, name, kind, base_url, default_model, encrypted_api_key, created_at, updated_at
            FROM providers WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await?
        .ok_or_else(|| AppError::configuration_not_found("Provider not found"))?;

        if input.name.is_none()
            && input.base_url.is_none()
            && input.default_model.is_none()
            && input.api_key.is_none()
        {
            return Err(AppError::invalid_request("At least one field is required"));
        }

        let name = match input.name.as_deref() {
            Some(value) => validate_name(value, 80, "name")?.to_owned(),
            None => existing.name.clone(),
        };
        let default_model = match input.default_model.as_deref() {
            Some(value) => validate_name(value, 160, "defaultModel")?.to_owned(),
            None => existing.default_model.clone(),
        };
        let base_url = if let Some(value) = input.base_url.as_ref() {
            normalize_base_url(value.as_deref(), &existing.kind)?
        } else {
            existing.base_url.clone()
        };
        let encrypted = if let Some(api_key) = input.api_key.as_deref() {
            let api_key = api_key.trim();
            if api_key.is_empty() || api_key.chars().count() > 4096 {
                return Err(AppError::invalid_request(
                    "apiKey must contain between 1 and 4096 characters",
                ));
            }
            self.vault.encrypt(api_key)?
        } else {
            existing.encrypted_api_key.clone()
        };
        let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        sqlx::query(
            r#"
            UPDATE providers SET
              name = ?, base_url = ?, default_model = ?, encrypted_api_key = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(name)
        .bind(base_url)
        .bind(default_model)
        .bind(encrypted)
        .bind(updated_at)
        .bind(id)
        .execute(self.database.pool())
        .await?;
        self.get_provider(id)
            .await?
            .ok_or_else(|| AppError::configuration_not_found("Provider not found"))
    }

    pub async fn list_agents(&self) -> Result<Vec<AgentProfile>, AppError> {
        let rows = sqlx::query_as::<_, AgentRow>(
            r#"
            SELECT id, name, description, system_prompt, provider_id, model, created_at, updated_at
            FROM agent_profiles
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(self.database.pool())
        .await?;
        Ok(rows.into_iter().map(AgentProfile::from).collect())
    }

    pub async fn get_agent(&self, id: &str) -> Result<Option<AgentProfile>, AppError> {
        let row = sqlx::query_as::<_, AgentRow>(
            r#"
            SELECT id, name, description, system_prompt, provider_id, model, created_at, updated_at
            FROM agent_profiles WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await?;
        Ok(row.map(AgentProfile::from))
    }

    pub async fn create_agent(&self, input: CreateAgentInput) -> Result<AgentProfile, AppError> {
        let name = validate_name(&input.name, 80, "name")?;
        let description = input.description.trim();
        if description.chars().count() > 400 {
            return Err(AppError::invalid_request(
                "description must contain at most 400 characters",
            ));
        }
        let system_prompt = input.system_prompt.trim();
        if system_prompt.is_empty() || system_prompt.chars().count() > 40_000 {
            return Err(AppError::invalid_request(
                "systemPrompt must contain between 1 and 40000 characters",
            ));
        }
        let model = validate_name(&input.model, 160, "model")?;
        let provider_id = parse_uuid(&input.provider_id, "providerId")?;
        if self.get_provider(&provider_id).await?.is_none() {
            return Err(AppError::configuration_reference_not_found(
                "Provider not found",
            ));
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        sqlx::query(
            r#"
            INSERT INTO agent_profiles (
              id, name, description, system_prompt, provider_id, model, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(name)
        .bind(description)
        .bind(system_prompt)
        .bind(provider_id)
        .bind(model)
        .bind(&now)
        .bind(&now)
        .execute(self.database.pool())
        .await?;
        self.get_agent(&id)
            .await?
            .ok_or_else(|| AppError::configuration("Agent insert disappeared"))
    }

    pub async fn update_agent(
        &self,
        id: &str,
        input: UpdateAgentInput,
    ) -> Result<AgentProfile, AppError> {
        let existing = self
            .get_agent(id)
            .await?
            .ok_or_else(|| AppError::configuration_not_found("Agent not found"))?;
        if input.name.is_none()
            && input.description.is_none()
            && input.system_prompt.is_none()
            && input.provider_id.is_none()
            && input.model.is_none()
        {
            return Err(AppError::invalid_request("At least one field is required"));
        }
        let name = match input.name.as_deref() {
            Some(value) => validate_name(value, 80, "name")?.to_owned(),
            None => existing.name,
        };
        let description = match input.description.as_deref() {
            Some(value) => {
                let value = value.trim();
                if value.chars().count() > 400 {
                    return Err(AppError::invalid_request(
                        "description must contain at most 400 characters",
                    ));
                }
                value.to_owned()
            }
            None => existing.description,
        };
        let system_prompt = match input.system_prompt.as_deref() {
            Some(value) => {
                let value = value.trim();
                if value.is_empty() || value.chars().count() > 40_000 {
                    return Err(AppError::invalid_request(
                        "systemPrompt must contain between 1 and 40000 characters",
                    ));
                }
                value.to_owned()
            }
            None => existing.system_prompt,
        };
        let model = match input.model.as_deref() {
            Some(value) => validate_name(value, 160, "model")?.to_owned(),
            None => existing.model,
        };
        let provider_id = match input.provider_id.as_deref() {
            Some(value) => {
                let provider_id = parse_uuid(value, "providerId")?;
                if self.get_provider(&provider_id).await?.is_none() {
                    return Err(AppError::configuration_reference_not_found(
                        "Provider not found",
                    ));
                }
                provider_id
            }
            None => existing.provider_id,
        };
        let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        sqlx::query(
            r#"
            UPDATE agent_profiles SET
              name = ?, description = ?, system_prompt = ?, provider_id = ?, model = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(name)
        .bind(description)
        .bind(system_prompt)
        .bind(provider_id)
        .bind(model)
        .bind(updated_at)
        .bind(id)
        .execute(self.database.pool())
        .await?;
        self.get_agent(id)
            .await?
            .ok_or_else(|| AppError::configuration_not_found("Agent not found"))
    }

    pub async fn list_permission_rules(&self) -> Result<Vec<PermissionRule>, AppError> {
        let rows = sqlx::query_as::<_, PermissionRuleRow>(
            r#"
            SELECT id, tool_name, effect, pattern, created_at
            FROM permission_rules
            ORDER BY CASE effect WHEN 'deny' THEN 0 WHEN 'ask' THEN 1 ELSE 2 END,
              created_at ASC, id ASC
            "#,
        )
        .fetch_all(self.database.pool())
        .await?;
        Ok(rows.into_iter().map(PermissionRule::from).collect())
    }

    pub async fn create_permission_rule(
        &self,
        input: CreatePermissionRuleInput,
    ) -> Result<PermissionRule, AppError> {
        let tool_name = validate_name(&input.tool_name, 80, "toolName")?;
        let effect = input.effect.trim();
        if !RULE_EFFECTS.contains(&effect) {
            return Err(AppError::invalid_request(format!(
                "Unsupported effect: {effect}"
            )));
        }
        let pattern = input.pattern.trim();
        if pattern.is_empty() || pattern.chars().count() > 512 {
            return Err(AppError::invalid_request(
                "pattern must contain between 1 and 512 characters",
            ));
        }
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        sqlx::query(
            r#"
            INSERT INTO permission_rules (id, tool_name, effect, pattern, created_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(tool_name)
        .bind(effect)
        .bind(pattern)
        .bind(&created_at)
        .execute(self.database.pool())
        .await?;
        Ok(PermissionRule {
            id,
            tool_name: tool_name.to_owned(),
            effect: effect.to_owned(),
            pattern: pattern.to_owned(),
            created_at,
        })
    }

    pub async fn delete_permission_rule(&self, id: &str) -> Result<bool, AppError> {
        let result = sqlx::query("DELETE FROM permission_rules WHERE id = ?")
            .bind(id)
            .execute(self.database.pool())
            .await?;
        Ok(result.rows_affected() > 0)
    }
}

fn validate_name<'a>(value: &'a str, max: usize, field: &str) -> Result<&'a str, AppError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(AppError::invalid_request(format!(
            "{field} must contain between 1 and {max} characters"
        )));
    }
    Ok(value)
}

fn validate_provider_kind(kind: &str) -> Result<&str, AppError> {
    let kind = kind.trim();
    if PROVIDER_KINDS.contains(&kind) {
        Ok(kind)
    } else {
        Err(AppError::invalid_request(format!(
            "Unsupported provider kind: {kind}"
        )))
    }
}

fn normalize_base_url(value: Option<&str>, kind: &str) -> Result<Option<String>, AppError> {
    match value {
        None | Some("") if kind == "openai_compatible" => Err(AppError::invalid_request(
            "Base URL is required for OpenAI-compatible providers",
        )),
        None | Some("") => Ok(None),
        Some(raw) => {
            let parsed = Url::parse(raw)
                .map_err(|_| AppError::invalid_request("baseUrl must be a valid URL"))?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return Err(AppError::invalid_request(
                    "baseUrl must be an http(s) URL",
                ));
            }
            Ok(Some(parsed.to_string()))
        }
    }
}

fn parse_uuid(value: &str, field: &str) -> Result<String, AppError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| AppError::invalid_request(format!("{field} must be a UUID")))
}

#[derive(FromRow)]
struct ProviderRow {
    id: String,
    name: String,
    kind: String,
    base_url: Option<String>,
    default_model: String,
    encrypted_api_key: String,
    created_at: String,
    updated_at: String,
}

impl From<ProviderRow> for Provider {
    fn from(row: ProviderRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            kind: row.kind,
            base_url: row.base_url,
            default_model: row.default_model,
            has_api_key: !row.encrypted_api_key.is_empty(),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(FromRow)]
struct AgentRow {
    id: String,
    name: String,
    description: String,
    system_prompt: String,
    provider_id: String,
    model: String,
    created_at: String,
    updated_at: String,
}

impl From<AgentRow> for AgentProfile {
    fn from(row: AgentRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            description: row.description,
            system_prompt: row.system_prompt,
            provider_id: row.provider_id,
            model: row.model,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(FromRow)]
struct PermissionRuleRow {
    id: String,
    tool_name: String,
    effect: String,
    pattern: String,
    created_at: String,
}

impl From<PermissionRuleRow> for PermissionRule {
    fn from(row: PermissionRuleRow) -> Self {
        Self {
            id: row.id,
            tool_name: row.tool_name,
            effect: row.effect,
            pattern: row.pattern,
            created_at: row.created_at,
        }
    }
}

