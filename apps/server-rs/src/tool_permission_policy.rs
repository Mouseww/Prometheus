use crate::models::PermissionRule;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow,
    Ask,
    Deny,
}

impl PermissionDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
}

#[derive(Clone, Debug)]
pub struct PermissionPolicyEvaluation {
    pub decision: PermissionDecision,
    pub rules: Vec<PermissionRule>,
}

pub fn evaluate_permission(
    rules: &[PermissionRule],
    tool_name: &str,
    target: &str,
) -> PermissionPolicyEvaluation {
    let rules = rules
        .iter()
        .filter(|rule| rule.tool_name == tool_name)
        .cloned()
        .collect::<Vec<_>>();
    let parsed = if tool_name == "shell_command" {
        split_shell_command(target)
    } else {
        ShellParse {
            segments: vec![target.to_owned()],
            complex: false,
        }
    };

    for effect in [PermissionDecision::Deny, PermissionDecision::Ask] {
        let matched = matching_rules(&rules, effect.as_str(), &parsed.segments);
        if !matched.is_empty() {
            return PermissionPolicyEvaluation {
                decision: effect,
                rules: matched,
            };
        }
    }

    if parsed.complex || parsed.segments.is_empty() {
        return PermissionPolicyEvaluation {
            decision: PermissionDecision::Ask,
            rules: Vec::new(),
        };
    }

    let allow_rules = rules
        .iter()
        .filter(|rule| rule.effect == "allow")
        .cloned()
        .collect::<Vec<_>>();
    let mut matched_allows = Vec::new();
    for segment in &parsed.segments {
        let requires_exact = tool_name == "shell_command" && is_shell_wrapper(segment);
        let segment_matches = allow_rules
            .iter()
            .filter(|rule| {
                matches_glob(&rule.pattern, segment)
                    && (!requires_exact || !rule.pattern.contains('*'))
            })
            .cloned()
            .collect::<Vec<_>>();
        if segment_matches.is_empty() {
            return PermissionPolicyEvaluation {
                decision: PermissionDecision::Ask,
                rules: Vec::new(),
            };
        }
        matched_allows.extend(segment_matches);
    }
    PermissionPolicyEvaluation {
        decision: PermissionDecision::Allow,
        rules: unique_rules(matched_allows),
    }
}

struct ShellParse {
    segments: Vec<String>,
    complex: bool,
}

fn matching_rules(
    rules: &[PermissionRule],
    effect: &str,
    targets: &[String],
) -> Vec<PermissionRule> {
    unique_rules(
        rules
            .iter()
            .filter(|rule| {
                rule.effect == effect
                    && targets
                        .iter()
                        .any(|target| matches_glob(&rule.pattern, target))
            })
            .cloned()
            .collect(),
    )
}

fn unique_rules(rules: Vec<PermissionRule>) -> Vec<PermissionRule> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for rule in rules {
        if seen.insert(rule.id.clone()) {
            out.push(rule);
        }
    }
    out
}

fn is_shell_wrapper(command: &str) -> bool {
    let trimmed = command.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("cmd ")
        || lower.starts_with("cmd.exe ")
        || lower.contains("powershell")
        || lower.contains("pwsh")
        || lower.contains(" -command")
        || lower.contains(" -encodedcommand")
        || lower.contains("sh -c")
        || lower.contains("sh -lc")
        || lower.contains("bash -c")
        || lower.contains("zsh -c")
}

fn split_shell_command(command: &str) -> ShellParse {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut complex = false;
    let chars: Vec<char> = command.chars().collect();
    let mut index = 0usize;
    let push = |current: &mut String, segments: &mut Vec<String>| {
        let segment = current.trim();
        if !segment.is_empty() {
            segments.push(segment.to_owned());
        }
        current.clear();
    };

    while index < chars.len() {
        let character = chars[index];
        let next = chars.get(index + 1).copied();
        if escaped {
            current.push(character);
            escaped = false;
            index += 1;
            continue;
        }
        if quote == Some('\'') {
            current.push(character);
            if character == '\'' {
                quote = None;
            }
            index += 1;
            continue;
        }
        if quote == Some('"') {
            current.push(character);
            if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quote = None;
            } else if character == '`' || (character == '$' && next == Some('(')) {
                complex = true;
            }
            index += 1;
            continue;
        }
        if character == '\\' {
            current.push(character);
            escaped = true;
            index += 1;
            continue;
        }
        if character == '\'' {
            current.push(character);
            quote = Some('\'');
            index += 1;
            continue;
        }
        if character == '"' {
            current.push(character);
            quote = Some('"');
            index += 1;
            continue;
        }
        if character == '`'
            || (character == '$' && next == Some('('))
            || ((character == '<' || character == '>') && next == Some('('))
        {
            complex = true;
            current.push(character);
            index += 1;
            continue;
        }
        let two = (character == '&' && next == Some('&'))
            || (character == '|' && (next == Some('|') || next == Some('&')));
        if two {
            push(&mut current, &mut segments);
            index += 2;
            continue;
        }
        if character == ';' || character == '|' || character == '&' || character == '\n' {
            push(&mut current, &mut segments);
            index += 1;
            continue;
        }
        current.push(character);
        index += 1;
    }
    push(&mut current, &mut segments);
    if quote.is_some() || escaped {
        complex = true;
    }
    ShellParse { segments, complex }
}

fn matches_glob(pattern: &str, target: &str) -> bool {
    let case_insensitive = cfg!(windows);
    let pattern = if case_insensitive {
        pattern.to_ascii_lowercase()
    } else {
        pattern.to_owned()
    };
    let target = if case_insensitive {
        target.to_ascii_lowercase()
    } else {
        target.to_owned()
    };
    let mut regex = String::from("^");
    for (index, part) in pattern.split('*').enumerate() {
        if index > 0 {
            regex.push_str(".*");
        }
        regex.push_str(&escape_regex(part));
    }
    regex.push('$');
    regex::Regex::new(&regex)
        .map(|compiled| compiled.is_match(&target))
        .unwrap_or(false)
}

fn escape_regex(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '|' | '\\' | '{' | '}' | '(' | ')' | '[' | ']' | '^' | '$' | '+' | '?' | '.' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, tool: &str, effect: &str, pattern: &str) -> PermissionRule {
        PermissionRule {
            id: id.into(),
            tool_name: tool.into(),
            effect: effect.into(),
            pattern: pattern.into(),
            created_at: "t".into(),
        }
    }

    #[test]
    fn deny_takes_precedence_over_allow() {
        let rules = vec![
            rule("1", "write_file", "allow", "notes/*"),
            rule("2", "write_file", "deny", "notes/secret.txt"),
        ];
        let evaluation = evaluate_permission(&rules, "write_file", "notes/secret.txt");
        assert_eq!(evaluation.decision, PermissionDecision::Deny);
        assert_eq!(evaluation.rules[0].id, "2");
    }

    #[test]
    fn allow_requires_all_shell_segments() {
        let rules = vec![rule("1", "shell_command", "allow", "echo hello")];
        let evaluation = evaluate_permission(&rules, "shell_command", "echo hello && rm -rf /");
        assert_eq!(evaluation.decision, PermissionDecision::Ask);
        assert!(evaluation.rules.is_empty());
    }
}
