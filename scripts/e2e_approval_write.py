import os
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


SCREENSHOT = Path(
    r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-approval-write.png"
)
WORKSPACE = Path(os.environ["PROMETHEUS_E2E_WORKSPACE"])
APP_URL = os.environ.get("PROMETHEUS_E2E_URL", "http://127.0.0.1:4310")


def create_task(page: Page, title: str, message: str) -> None:
    page.locator("button.mini-button").click()
    page.get_by_placeholder("e.g. Ship authentication flow").fill(title)
    page.locator(".modal-card").get_by_role("button", name="Create task").click()
    page.locator("textarea").fill(message)
    page.get_by_role("button", name="Transmit").click()


def open_reviewer(browser, button_name: str):
    context = browser.new_context(viewport={"width": 1180, "height": 820})
    page = context.new_page()
    page.goto(APP_URL)
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name=button_name).wait_for(timeout=15_000)
    return context, page


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    primary_context = browser.new_context(viewport={"width": 1440, "height": 900})
    primary = primary_context.new_page()
    console_errors: list[str] = []
    primary.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    primary.goto(APP_URL)
    primary.wait_for_load_state("networkidle")

    primary.get_by_role("button", name="Configure runtime").click()
    provider_form = primary.locator(".runtime-form").nth(0)
    provider_form.get_by_label("Protocol").select_option("openai_compatible")
    provider_form.get_by_label("Name").fill("Approval fixture")
    provider_form.get_by_label("Base URL").fill("http://127.0.0.1:4320/v1")
    provider_form.get_by_label("Default model").fill("fixture-model")
    provider_form.get_by_label("API key").fill("fixture-secret")
    provider_form.get_by_role("button", name="Save provider").click()

    agent_form = primary.locator(".runtime-form").nth(1)
    agent_form.get_by_label("Provider").locator("option", has_text="Approval fixture").wait_for(state="attached")
    agent_form.get_by_label("Name").fill("Approval writer")
    agent_form.get_by_label("Description").fill("Writes only after cross-device approval")
    agent_form.get_by_label("System prompt").fill("Answer with verifiable evidence.")
    agent_form.get_by_role("button", name="Save agent").click()
    primary.locator(".runtime-modal-header .icon-button").click()
    primary.locator(".agent-selector option", has_text="Approval writer").wait_for(state="attached")

    create_task(primary, "Approved write verification", "Create an approved workspace note.")
    reviewer_context, reviewer = open_reviewer(browser, "Approve write to approved-note.txt")
    reviewer.get_by_role("button", name="Approve write to approved-note.txt").click()
    reviewer.get_by_text("Approved on a connected terminal", exact=True).wait_for(timeout=15_000)
    primary.get_by_text("Approved write completed.", exact=True).wait_for(timeout=15_000)
    primary.get_by_text("0008", exact=True).wait_for(timeout=15_000)
    reviewer_context.close()

    approved_file = WORKSPACE / "approved-note.txt"
    assert approved_file.read_text(encoding="utf-8") == "Prometheus approval runtime verified.\n"

    create_task(primary, "Denied write verification", "Attempt a denied workspace note.")
    deny_context, deny_reviewer = open_reviewer(browser, "Deny write to denied-note.txt")
    deny_reviewer.get_by_role("button", name="Deny write to denied-note.txt").click()
    deny_reviewer.get_by_text("Denied on a connected terminal", exact=True).wait_for(timeout=15_000)
    primary.get_by_text("Denied write was not executed.", exact=True).wait_for(timeout=15_000)
    assert not (WORKSPACE / "denied-note.txt").exists()

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    primary.screenshot(path=str(SCREENSHOT), full_page=True)
    deny_context.close()
    assert not console_errors, console_errors
    print("cross_device_approval=ok")
    print("approved_write_real_file=ok")
    print("denied_write_no_file=ok")
    print("durable_approval_sequence=ok")
    print(f"screenshot={SCREENSHOT}")
    primary_context.close()
    browser.close()
