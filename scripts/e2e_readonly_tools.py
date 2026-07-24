import os
from pathlib import Path

from playwright.sync_api import sync_playwright


SCREENSHOT = Path(r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-readonly-tools.png")
APP_URL = os.environ.get("PROMETHEUS_E2E_URL", "http://127.0.0.1:4310")

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    console_errors: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.goto(APP_URL)
    page.wait_for_load_state("networkidle")

    page.get_by_role("button", name="Configure runtime").click()
    provider_form = page.locator(".runtime-form").nth(0)
    provider_form.get_by_label("Protocol").select_option("openai_compatible")
    provider_form.get_by_label("Name").fill("Local tool fixture")
    provider_form.get_by_label("Base URL").fill("http://127.0.0.1:4320/v1")
    provider_form.get_by_label("Default model").fill("fixture-model")
    provider_form.get_by_label("API key").fill("fixture-secret")
    provider_form.get_by_role("button", name="Save provider").click()

    agent_form = page.locator(".runtime-form").nth(1)
    agent_form.get_by_label("Provider").locator(
        "option", has_text="Local tool fixture"
    ).wait_for(state="attached")
    agent_form.get_by_label("Name").fill("Workspace inspector")
    agent_form.get_by_label("Description").fill("Uses real read-only workspace tools")
    agent_form.get_by_label("System prompt").fill("Answer with verifiable evidence.")
    agent_form.get_by_role("button", name="Save agent").click()
    page.locator(".runtime-modal-header .icon-button").click()
    page.locator(".agent-selector option", has_text="Workspace inspector").wait_for(
        state="attached"
    )

    page.locator("button.mini-button").click()
    page.get_by_placeholder("e.g. Ship authentication flow").fill("Read-only tool verification")
    page.locator(".modal-card").get_by_role("button", name="Create task").click()
    page.locator("textarea").fill("Inspect the repository with tools.")
    page.get_by_role("button", name="Transmit").click()
    page.get_by_text("Running read_file", exact=True).wait_for(timeout=15_000)
    page.get_by_text("Completed read_file", exact=True).wait_for(timeout=15_000)
    page.get_by_text(
        "Workspace evidence: README identifies the project as Prometheus.",
        exact=True,
    ).wait_for(timeout=15_000)
    page.get_by_text("0006", exact=True).wait_for(timeout=15_000)

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    assert not console_errors, console_errors
    print("provider_tool_call=ok")
    print("workspace_read=ok")
    print("tool_result_round_trip=ok")
    print("durable_tool_events=ok")
    print("final_grounded_reply=ok")
    print(f"screenshot={SCREENSHOT}")
    browser.close()
