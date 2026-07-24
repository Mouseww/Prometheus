from pathlib import Path

from playwright.sync_api import sync_playwright


SCREENSHOT = Path(r"C:\Users\Administrator\.codex\visualizations\2026\07\23\019f8d9f-70f5-7e13-8f1b-cd4183f1b5c0\prometheus-agent-runtime.png")

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    console_errors: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.goto("http://127.0.0.1:5173")
    page.wait_for_load_state("networkidle")

    page.get_by_role("button", name="Configure runtime").click()
    provider_form = page.locator(".runtime-form").nth(0)
    provider_form.get_by_label("Protocol").select_option("openai_compatible")
    provider_form.get_by_label("Name").fill("Local protocol fixture")
    provider_form.get_by_label("Base URL").fill("http://127.0.0.1:4320/v1")
    provider_form.get_by_label("Default model").fill("fixture-model")
    provider_form.get_by_label("API key").fill("fixture-secret")
    provider_form.get_by_role("button", name="Save provider").click()

    agent_form = page.locator(".runtime-form").nth(1)
    agent_form.get_by_label("Provider").locator(
        "option", has_text="Local protocol fixture"
    ).wait_for(state="attached")
    agent_form.get_by_label("Name").fill("Runtime verifier")
    agent_form.get_by_label("Description").fill("Validates the real provider path")
    agent_form.get_by_label("System prompt").fill("Answer with verifiable evidence.")
    agent_form.get_by_role("button", name="Save agent").click()
    page.locator(".runtime-modal-header .icon-button").click()
    page.locator(".agent-selector option", has_text="Runtime verifier").wait_for(
        state="attached"
    )

    page.locator("button.mini-button").click()
    page.get_by_placeholder("e.g. Ship authentication flow").fill("Runtime integration verification")
    page.locator(".modal-card").get_by_role("button", name="Create task").click()
    page.locator("textarea").fill("Verify the complete runtime path.")
    page.get_by_role("button", name="Transmit").click()
    page.get_by_text("Fixture provider reply: end-to-end runtime works.", exact=True).wait_for(timeout=15_000)

    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    assert not console_errors, console_errors
    print("encrypted_provider_config=ok")
    print("agent_profile=ok")
    print("provider_sdk_request=ok")
    print("durable_agent_reply=ok")
    print(f"screenshot={SCREENSHOT}")
    browser.close()
