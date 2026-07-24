import os
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


SCREENSHOT = Path(
    r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-shell-command.png"
)
WORKSPACE = Path(os.environ["PROMETHEUS_E2E_WORKSPACE"])
APP_URL = os.environ.get("PROMETHEUS_E2E_URL", "http://127.0.0.1:4310")


def configure_runtime(page: Page) -> None:
    page.get_by_role("button", name="Configure runtime").click()
    provider_form = page.locator(".runtime-form").nth(0)
    provider_form.get_by_label("Protocol").select_option("openai_compatible")
    provider_form.get_by_label("Name").fill("Shell fixture")
    provider_form.get_by_label("Base URL").fill("http://127.0.0.1:4320/v1")
    provider_form.get_by_label("Default model").fill("fixture-model")
    provider_form.get_by_label("API key").fill("fixture-secret")
    provider_form.get_by_role("button", name="Save provider").click()

    agent_form = page.locator(".runtime-form").nth(1)
    agent_form.get_by_label("Provider").locator("option", has_text="Shell fixture").wait_for(state="attached")
    agent_form.get_by_label("Name").fill("Shell operator")
    agent_form.get_by_label("Description").fill("Runs approved workspace commands")
    agent_form.get_by_label("System prompt").fill("Answer with verifiable evidence.")
    agent_form.get_by_role("button", name="Save agent").click()
    page.locator(".runtime-modal-header .icon-button").click()
    page.locator(".agent-selector option", has_text="Shell operator").wait_for(state="attached")


def create_task(page: Page) -> None:
    page.locator("button.mini-button").click()
    page.get_by_placeholder("e.g. Ship authentication flow").fill("Approved shell verification")
    page.locator(".modal-card").get_by_role("button", name="Create task").click()
    page.locator("textarea").fill("Execute an approved shell command.")
    page.get_by_role("button", name="Transmit").click()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    primary_context = browser.new_context(viewport={"width": 1440, "height": 900})
    primary = primary_context.new_page()
    console_errors: list[str] = []
    primary.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    primary.goto(APP_URL)
    primary.wait_for_load_state("networkidle")
    configure_runtime(primary)
    create_task(primary)

    reviewer_context = browser.new_context(viewport={"width": 1180, "height": 820})
    reviewer = reviewer_context.new_page()
    reviewer.goto(APP_URL)
    reviewer.wait_for_load_state("networkidle")
    reviewer.get_by_role("button", name="Approve shell command").wait_for(timeout=15_000)
    reviewer.get_by_text("shell-note.txt", exact=False).wait_for(timeout=15_000)
    reviewer.get_by_role("button", name="Approve shell command").click()
    reviewer.get_by_text("Approved on a connected terminal", exact=True).wait_for(timeout=15_000)

    primary.get_by_text("Approved shell command completed.", exact=True).wait_for(timeout=15_000)
    primary.get_by_text("0008", exact=True).wait_for(timeout=15_000)
    assert (WORKSPACE / "shell-note.txt").read_text(encoding="utf-8") == "Prometheus shell runtime verified."

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    primary.screenshot(path=str(SCREENSHOT), full_page=True)
    assert not console_errors, console_errors
    print("cross_device_shell_approval=ok")
    print("real_shell_workspace_side_effect=ok")
    print("durable_shell_sequence=ok")
    print(f"screenshot={SCREENSHOT}")
    reviewer_context.close()
    primary_context.close()
    browser.close()
