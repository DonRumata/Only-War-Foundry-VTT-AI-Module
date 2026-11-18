/**
 * Minimal sheet controls (issue #399).
 *
 * - `renderActorSheet` hook injects an "Only War AI" fieldset into NPC sheets
 *   (checkbox "AI enabled" + preset select) writing
 *   `flags["only-war-ai"].config`.
 * - `renderTokenConfig` hook injects the Token-level override
 *   (mode select + optional preset) writing `flags["only-war-ai"].override`.
 *
 * Both controls only mutate flags; permission checks are delegated to the
 * document update pipeline (GM and owners may edit).
 */
import {
    AI_PRESETS,
    FLAG_KEYS,
    MODULE_ID,
    OVERRIDE_MODES
} from "../constants.js";
import { isModuleEnabled } from "../module-state.js";

/** Register the sheet injection hooks. Called on `init`. */
export function registerSheetControls() {
    Hooks.on("renderActorSheet", (app, html) => {
        if (!isModuleEnabled()) return;
        const actor = app.actor ?? app.document;
        if (!actor || actor.type !== "npc") return;
        _injectNpcSection(html, actor);
    });

    Hooks.on("renderTokenConfig", (app, html) => {
        if (!isModuleEnabled()) return;
        const token = app.document ?? app.object ?? app.token;
        if (!token) return;
        _injectTokenSection(html, token);
    });
}

/**
 * Inject the NPC default AI configuration section into a rendered sheet.
 * @param {jQuery|HTMLElement} html
 * @param {object} actor
 */
function _injectNpcSection(html, actor) {
    const root = _findInjectionTarget(html);
    if (!root || root.querySelector?.("[data-ow-ai-config]") || root.find?.("[data-ow-ai-config]").length) return;

    const config = actor.getFlag?.(MODULE_ID, FLAG_KEYS.actorConfig) ?? {};
    const enabled = config.enabled === true;
    const preset = AI_PRESETS.includes(config.preset) ? config.preset : "";

    const section = _buildElement(`
        <fieldset class="ow-ai-config" data-ow-ai-config>
            <legend>${_localize("OWAI.Sheet.Section")}</legend>
            <div class="form-group">
                <label>${_localize("OWAI.Sheet.Enabled")}</label>
                <input type="checkbox" data-ow-ai-field="enabled" ${enabled ? "checked" : ""}>
            </div>
            <div class="form-group">
                <label>${_localize("OWAI.Sheet.Preset")}</label>
                <select data-ow-ai-field="preset">
                    ${_presetOptions(preset, true)}
                </select>
            </div>
        </fieldset>
    `);

    section.querySelectorAll("[data-ow-ai-field]").forEach(input => {
        input.addEventListener("change", () => _saveActorConfig(actor, section));
    });
    _append(root, section);
}

/**
 * Inject the Token override section into a rendered TokenConfig sheet.
 * @param {jQuery|HTMLElement} html
 * @param {object} token TokenDocument.
 */
function _injectTokenSection(html, token) {
    const root = _findInjectionTarget(html);
    if (!root || root.querySelector?.("[data-ow-ai-override]") || root.find?.("[data-ow-ai-override]").length) return;

    const override = token.getFlag?.(MODULE_ID, FLAG_KEYS.override) ?? {};
    const mode = OVERRIDE_MODES.includes(override.mode) ? override.mode : "inherit";
    const preset = AI_PRESETS.includes(override.preset) ? override.preset : "";

    const section = _buildElement(`
        <fieldset class="ow-ai-config" data-ow-ai-override>
            <legend>${_localize("OWAI.Sheet.Section")}</legend>
            <div class="form-group">
                <label>${_localize("OWAI.Sheet.Mode")}</label>
                <select data-ow-ai-field="mode">
                    ${OVERRIDE_MODES.map(m =>
        `<option value="${m}" ${m === mode ? "selected" : ""}>${_localize(`OWAI.Mode.${m}`)}</option>`
    ).join("")}
                </select>
            </div>
            <div class="form-group">
                <label>${_localize("OWAI.Sheet.Preset")}</label>
                <select data-ow-ai-field="preset">
                    ${_presetOptions(preset, true)}
                </select>
            </div>
        </fieldset>
    `);

    section.querySelectorAll("[data-ow-ai-field]").forEach(input => {
        input.addEventListener("change", () => _saveOverride(token, section));
    });
    _append(root, section);
}

/**
 * Persist the actor-level config flag from the injected section.
 * @param {object} actor
 * @param {HTMLElement} section
 */
async function _saveActorConfig(actor, section) {
    const enabled = section.querySelector("[data-ow-ai-field=enabled]")?.checked === true;
    const presetValue = section.querySelector("[data-ow-ai-field=preset]")?.value ?? "";
    const preset = AI_PRESETS.includes(presetValue) ? presetValue : null;
    try {
        await actor.setFlag(MODULE_ID, FLAG_KEYS.actorConfig, { enabled, preset });
    } catch(err) {
        console.error(`${MODULE_ID} | Failed to save actor AI config`, err);
    }
}

/**
 * Persist the override flag from an injected section (Token or Combatant UI).
 * @param {object} doc
 * @param {HTMLElement} section
 */
async function _saveOverride(doc, section) {
    const modeValue = section.querySelector("[data-ow-ai-field=mode]")?.value ?? "inherit";
    const mode = OVERRIDE_MODES.includes(modeValue) ? modeValue : "inherit";
    const presetValue = section.querySelector("[data-ow-ai-field=preset]")?.value ?? "";
    const preset = AI_PRESETS.includes(presetValue) ? presetValue : null;
    try {
        await doc.setFlag(MODULE_ID, FLAG_KEYS.override, { mode, preset });
    } catch(err) {
        console.error(`${MODULE_ID} | Failed to save override`, err);
    }
}

/**
 * Find the element to append the section to: the sheet's form body when
 * present, else the rendered root. Supports both jQuery and HTMLElement
 * arguments (AppV1 vs AppV2 sheets).
 * @param {jQuery|HTMLElement} html
 * @returns {HTMLElement|jQuery|null}
 */
function _findInjectionTarget(html) {
    if (!html) return null;
    if (html instanceof HTMLElement) {
        return html.querySelector("form .sheet-body")
            ?? html.querySelector(".sheet-body")
            ?? html.querySelector("form")
            ?? html;
    }
    if (typeof html.find === "function") {
        const body = html.find("form .sheet-body").first();
        if (body.length) return body;
        const form = html.find("form").first();
        if (form.length) return form;
    }
    return html;
}

/**
 * Append a child element to either a jQuery set or an HTMLElement.
 * @param {HTMLElement|jQuery} root
 * @param {HTMLElement} element
 */
function _append(root, element) {
    if (root instanceof HTMLElement) {
        root.appendChild(element);
    } else if (typeof root?.append === "function") {
        root.append(element);
    }
}

/**
 * Build a detached element from an HTML string.
 * @param {string} markup
 * @returns {HTMLElement}
 */
function _buildElement(markup) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = markup.trim();
    return wrapper.firstElementChild;
}

/**
 * Build `<option>` markup for the fixed preset list.
 * @param {string} selected
 * @param {boolean} includeEmpty
 * @returns {string}
 */
function _presetOptions(selected, includeEmpty) {
    const options = includeEmpty
        ? [`<option value="">${_localize("OWAI.Preset.none")}</option>`]
        : [];
    for (const preset of AI_PRESETS) {
        options.push(
            `<option value="${preset}" ${preset === selected ? "selected" : ""}>${_localize(`OWAI.Preset.${preset}`)}</option>`
        );
    }
    return options.join("");
}

/**
 * Localize a key, tolerating early init states.
 * @param {string} key
 * @returns {string}
 */
function _localize(key) {
    return game.i18n?.localize?.(key) ?? key;
}
