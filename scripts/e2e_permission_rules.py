import os
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


SCREENSHOT = Path(
    r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-permission-rules.png"
)
WORKSPACE = Path(os.environ["PROMETHEUS_E2E_WORKSPACE"])
APP_URL = os.environ.get("PROMETHEUS_E2E_URL", "http://127.0.0.1:4310")


def configure_runtime_and_rules(page: Page) -> None:
    page.get_by_role("button", name="Configure runtime").click()
    provider_form = page.locator(".runtime-form").nth(0)
    provider_form.get_by_label("Protocol").select_option("openai_compatible")
    provider_form.get_by_label("Name").fill("Permission fixture")
    provider_form.get_by_label("Base URL").fill("http://127.0.0.1:4320/v1")
    provider_form.get_by_label("Default model").fill("fixture-model")
    provider_form.get_by_label("API key").fill("fixture-secret")
    provider_form.get_by_role("button", name="Save provider").click()

    agent_form = page.locator(".runtime-form").nth(1)
    agent_form.get_by_label("Provider").locator("option", has_text="Permission fixture").wait_for(state="attached")
    agent_form.get_by_label("Name").fill("Policy operator")
    agent_form.get_by_label("Description").fill("Exercises persistent permission rules")
    agent_form.get_by_label("System prompt").fill("Answer with verifiable evidence.")
    agent_form.get_by_role("button", name="Save agent").click()

    page.get_by_label("Permission tool").select_option("shell_command")
    page.get_by_label("Permission effect").select_option("allow")
    page.get_by_label("Permission pattern").fill("node -e *")
    page.get_by_role("button", name="Add rule").click()
    page.get_by_text("node -e *", exact=True).wait_for(state="visible")

    page.get_by_label("Permission effect").select_option("deny")
    page.get_by_label("Permission pattern").fill("*blocked-rule*")
    page.get_by_role("button", name="Add rule").click()
    page.get_by_text("*blocked-rule*", exact=True).wait_for(state="visible")
    page.locator(".runtime-modal-header .icon-button").click()
    page.locator(".agent-selector option", has_text="Policy operator").wait_for(state="attached")


def create_task(page: Page, title: str, message: str) -> None:
    page.locator("button.mini-button").click()
    page.get_by_placeholder("e.g. Ship authentication flow").fill(title)
    page.locator(".modal-card").get_by_role("button", name="Create task").click()
    page.locator("textarea").fill(message)
    page.get_by_role("button", name="Transmit").click()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 980})
    page = context.new_page()
    console_errors: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.goto(APP_URL)
    page.wait_for_load_state("networkidle")
    configure_runtime_and_rules(page)

    create_task(page, "Permission allow verification", "Execute a permission-allowed shell command.")
    page.get_by_text("Allowed shell_command by permission rule", exact=True).wait_for(timeout=15_000)
    page.get_by_text("Permission rule allowed shell command.", exact=True).wait_for(timeout=15_000)
    assert page.get_by_role("button", name="Approve shell command").count() == 0
    assert (WORKSPACE / "allowed-rule.txt").read_text(encoding="utf-8") == "Prometheus permission policy verified."

    create_task(page, "Permission deny verification", "Attempt a permission-denied shell command.")
    page.get_by_text("Denied shell_command by permission rule", exact=True).wait_for(timeout=15_000)
    page.get_by_text("Permission rule denied shell command.", exact=True).wait_for(timeout=15_000)
    assert page.get_by_role("button", name="Approve shell command").count() == 0
    assert not (WORKSPACE / "blocked-rule.txt").exists()

    page.get_by_role("button", name="Configure runtime").click()
    page.get_by_text("DENY", exact=True).wait_for(state="visible")
    page.get_by_text("*blocked-rule*", exact=True).wait_for(state="visible")
    page.get_by_text("node -e *", exact=True).wait_for(state="visible")
    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SCREENSHOT), full_page=True)

    assert not console_errors, console_errors
    print("persistent_permission_rules=ok")
    print("allow_rule_real_shell_side_effect=ok")
    print("deny_precedence_blocks_side_effect=ok")
    print("durable_permission_audit=ok")
    print(f"screenshot={SCREENSHOT}")
    context.close()
    browser.close()
