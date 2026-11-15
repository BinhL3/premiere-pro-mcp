import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand, BridgeOptions } from "../bridge/file-bridge.js";

const LUMETRI_SECTION_HEADER_NAMES = [
  "Basic Correction",
  "Creative",
  "Curves",
  "Color Wheels & Match",
  "HSL Secondary",
  "Vignette",
];

/** Shared ES3 readback for the two QE effect-add paths. */
function applyEffectWithReadback(kind: "Video" | "Audio"): string {
  return `
    var before = [];
    function readComponents() {
      var components = result.clip.components;
      var count = components && components.numItems;
      if (typeof count !== "number" || !isFinite(count) || count < 0 || Math.floor(count) !== count) {
        throw new Error("Component count is unavailable");
      }
      var snapshot = [];
      for (var c = 0; c < count; c++) {
        snapshot.push({ displayName: String(components[c].displayName || ""), matchName: String(components[c].matchName || "") });
      }
      return snapshot;
    }
    try { before = readComponents(); }
    catch (beforeError) { return __error("Cannot read components before adding the effect; nothing was changed."); }
    var addError = "";
    try { qeClip.add${kind}Effect(qeEffect); }
    catch (effectError) { addError = String(effectError); }
    var after = null;
    var added = [];
    try {
      after = readComponents();
      var matched = [];
      for (var a = 0; a < after.length; a++) {
        var found = false;
        for (var b = 0; b < before.length; b++) {
          if (!matched[b] && before[b].displayName === after[a].displayName && before[b].matchName === after[a].matchName) {
            matched[b] = true;
            found = true;
            break;
          }
        }
        if (!found) added.push(after[a]);
      }
    } catch (readError) { after = null; }
    var data = {
      effect: effectName, lookupSource: lookupSource, clipName: result.clip.name,
      componentCountBefore: before.length, componentCountAfter: after ? after.length : null,
      addedComponents: added, verified: false, outcome: "committed_unverified",
      renderVerified: false, verificationScope: "Component-list readback only; verify live playback or rendered output before delivery."
    };
    if (after && after.length > before.length && added.length > 0) {
      data.timelineChanged = true;
      if (!addError) {
        data.applied = true;
        data.verified = true;
        data.outcome = "verified";
        return __result(data);
      }
    }
    var undoNow = typeof __readUndoIndex === "function" && __undoStart !== null ? __readUndoIndex() : null;
    if (__undoStart !== null && undoNow !== null && undoNow === __undoStart && after && after.length === before.length && added.length === 0 && !addError) {
      data.outcome = "not_applied";
      return __jsonStringify({ success: false, error: "Premiere added no component for " + effectName + "; nothing was changed.", data: data });
    }
    data.note = "Do not retry blindly: QE may have added the effect even when it is missing from the DOM component list. Inspect the clip before retrying.";
    if (addError) data.hostError = addError;
    if (typeof __readUndoIndex === "function" && __undoStart !== null) {
      if (undoNow !== null && undoNow > __undoStart) {
        data.undoSteps = undoNow - __undoStart;
        data.undoStackIndex = undoNow;
        data.timelineChanged = true;
      }
    }
    return __jsonStringify({ success: false, error: "Effect addition could not be verified. " + data.note, data: data });
  `;
}

/** ES3 prelude resolving QE audio track `trackIndex` for the track-insert tools. */
function audioTrackPrelude(trackIndex: number): string {
  return `
    try { app.enableQE(); } catch (eEnableQe) { return __refuse("Capability error: the QE DOM is unavailable (" + eEnableQe + "); nothing was changed."); }
    var seq = app.project.activeSequence;
    if (!seq) return __refuse("No active sequence");
    var qeSeq = null;
    try { qeSeq = qe.project.getActiveSequence(); } catch (eQeSeq) {}
    if (!qeSeq) return __refuse("No active sequence (QE)");
    var trackIndex = ${trackIndex};
    if (trackIndex >= seq.audioTracks.numTracks) return __refuse("Audio track index " + trackIndex + " is out of range; the sequence has " + seq.audioTracks.numTracks + " audio track(s).");
    function readQeTrack() {
      var found = null;
      try { found = qeSeq.getAudioTrackAt(trackIndex); } catch (eTrack) {}
      return found;
    }
    var qeTrack = readQeTrack();
    if (!qeTrack) return __refuse("QE audio track " + trackIndex + " not found");
    var trackName = "";
    try { trackName = String(seq.audioTracks[trackIndex].name); } catch (eTrackName) {}
  `;
}

const TRACK_INDEX_PARAMETER = {
  type: "number",
  description: "Zero-based audio track index (0 is A1)",
};

function invalidTrackIndex(value: unknown): boolean {
  return !Number.isInteger(value) || (value as number) < 0;
}

// Audio Track Mixer insert slots per track, numbered 1-5 as Premiere shows them.
const TRACK_INSERT_SLOTS = 5;

function invalidInsertSlot(value: unknown): boolean {
  return !Number.isInteger(value) || (value as number) < 1 || (value as number) > TRACK_INSERT_SLOTS;
}

export function getEffectsTools(bridgeOptions: BridgeOptions) {
  return {
    apply_effect: {
      description: "Apply a video effect to a video clip (audio clips are refused; use apply_audio_effect). Experimental QE DOM catalog lookup includes an exact-name probe when enumeration is empty. A component-list readback does not verify rendered pixels.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip to apply the effect to",
          },
          effect_name: {
            type: "string",
            description: "Name of the effect (e.g., 'Gaussian Blur', 'Lumetri Color')",
          },
        },
        required: ["node_id", "effect_name"],
      },
      handler: async (args: { node_id: string; effect_name: string }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __refuse("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __refuse("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var effectName = "${escapeForExtendScript(args.effect_name)}";
          // QE's by-name getters do not filter by kind; never put a video effect on an audio clip.
          if (result.trackType !== "video") return __refuse("apply_effect adds video effects, and " + result.clip.name + " is an audio clip. Use apply_audio_effect; nothing was changed.");
          var qeTrack = qeSeq.getVideoTrackAt(result.trackIndex);
          if (!qeTrack) return __refuse("QE track not found");

          // QE track items include gaps, so the DOM clip index is not a QE index.
          var qeClip = __findQeClipByDomClip(qeTrack, result.clip);
          if (!qeClip) return __refuse("Could not match the QE clip for " + result.clip.name + " by timeline start; nothing was changed.");

          // Premiere 26 can expose direct by-name lookup while returning an
          // empty QE catalog. Probe the requested name before consulting the
          // catalog so a known installed effect remains usable.
          if (__qeEffectIsOtherKindOnly("video", effectName)) return __refuse(effectName + " is an audio effect, not a video effect. Use apply_audio_effect on an audio clip, or add_audio_track_effect for an Audio Track Mixer insert; nothing was changed.");
          var qeEffect = null;
          try { qeEffect = qe.project.getVideoEffectByName(effectName); } catch (byNameError) {}
          if (qeEffect && !__qeEffectNameMatches(qeEffect, effectName)) qeEffect = null;
          var lookupSource = qeEffect ? "qe.byName" : "qe.catalog";
          if (!qeEffect) {
            var effectCatalog = __getQeEffectCatalog("video");
            if (!effectCatalog.ok) return __error(effectCatalog.error + " Direct QE lookup for \\"" + effectName + "\\" also did not resolve an effect.");
            var effects = effectCatalog.effects;
            for (var i = 0; i < effects.numItems; i++) {
              if (effects[i].name === effectName) {
                qeEffect = __qeEffectObject("video", effects[i]);
                break;
              }
            }
          }
          if (!qeEffect) return __error("Effect not found: " + effectName);
          ${applyEffectWithReadback("Video")}
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    apply_audio_effect: {
      description: "Apply an audio effect to one audio clip (video clips are refused). It is a clip effect; use add_audio_track_effect for an Audio Track Mixer track insert. Experimental QE catalog lookup includes an exact-name probe when enumeration is empty. A component-list readback does not verify rendered audio.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_name: {
            type: "string",
            description: "Name of the audio effect",
          },
        },
        required: ["node_id", "effect_name"],
      },
      handler: async (args: { node_id: string; effect_name: string }) => {
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __refuse("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __refuse("Clip not found");
          
          var effectName = "${escapeForExtendScript(args.effect_name)}";
          if (result.trackType !== "audio") return __refuse("apply_audio_effect adds audio effects, and " + result.clip.name + " is a video clip. Use apply_effect; nothing was changed.");
          var qeTrack = qeSeq.getAudioTrackAt(result.trackIndex);
          if (!qeTrack) return __refuse("QE audio track not found");

          // QE track items include gaps, so the DOM clip index is not a QE index.
          var qeClip = __findQeClipByDomClip(qeTrack, result.clip);
          if (!qeClip) return __refuse("Could not match the QE clip for " + result.clip.name + " by timeline start; nothing was changed.");
          
          if (__qeEffectIsOtherKindOnly("audio", effectName)) return __refuse(effectName + " is a video effect, not an audio effect. Use apply_effect on a video clip; nothing was changed.");
          var qeEffect = null;
          try { qeEffect = qe.project.getAudioEffectByName(effectName); } catch (byNameError) {}
          if (qeEffect && !__qeEffectNameMatches(qeEffect, effectName)) qeEffect = null;
          var lookupSource = qeEffect ? "qe.byName" : "qe.catalog";
          if (!qeEffect) {
            var effectCatalog = __getQeEffectCatalog("audio");
            if (!effectCatalog.ok) return __refuse(effectCatalog.error + " Direct QE lookup for \\"" + effectName + "\\" also did not resolve an effect.");
            var effects = effectCatalog.effects;
            for (var i = 0; i < effects.numItems; i++) {
              if (effects[i].name === effectName) {
                qeEffect = __qeEffectObject("audio", effects[i]);
                break;
              }
            }
          }
          if (!qeEffect) return __error("Audio effect not found: " + effectName);
          ${applyEffectWithReadback("Audio")}
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    remove_effect: {
      description: "Remove one effect from a clip by its index or name (the last instance when names repeat) and verify the clip's components afterwards. Built-in components (Opacity, Motion, Time Remapping, Volume, Channel Volume, Panner) cannot be removed; applied audio effects whose match name starts with \"Internal\" (such as Internal Highpass) can. EXPERIMENTAL: when Premiere has no Component.remove() (25.2), it removes through the undocumented QE DOM's targeted qeClip.getComponentAt(i).remove(). Every matching component's removal path is checked before any is removed; it returns a capability error, with nothing changed, when neither path is available.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          effect_index: {
            type: "integer",
            minimum: 0,
            description: "Index of the effect to remove (0-based). Use get_clip_properties to see effects list.",
          },
          effect_name: {
            type: "string",
            description: "Name of the effect to remove (alternative to effect_index)",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string; effect_index?: number; effect_name?: string }) => {
        if (args.effect_index !== undefined && (!Number.isSafeInteger(args.effect_index) || args.effect_index < 0)) {
          return { success: false, error: "effect_index must be a non-negative safe integer", data: { mutationOutcome: "not_applied", timelineChanged: false } };
        }
        const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __refuse("Clip not found");
          var clip = result.clip;
          ${args.effect_index !== undefined ? `
          var chosen = ${args.effect_index};
          if (chosen < 0 || chosen >= clip.components.numItems) return __error("Effect index out of range", { mutationOutcome: "not_applied", timelineChanged: false });
          var effectName = String(clip.components[chosen].displayName);
          ` : `
          var effectName = "${escapeForExtendScript(args.effect_name || "")}";
          var chosen = -1;
          for (var i = clip.components.numItems - 1; i >= 0; i--) {
            if (clip.components[i].displayName === effectName) { chosen = i; break; }
          }
          if (chosen < 0) return __error("Effect not found: " + effectName, { mutationOutcome: "not_applied", timelineChanged: false });
          `}
          if (__isBuiltInComponentForClip(clip.components[chosen], result.trackType)) return __error(effectName + " is a built-in clip component, not an effect, and cannot be removed.", { mutationOutcome: "not_applied", timelineChanged: false });
          var removal = __removeClipComponents(result, function (name, index) { return index === chosen; });
          var failureReceipt = removal.receipt;
          var uncertainty = removal.uncertainty ? " " + removal.uncertainty : "";
          if (removal.unsupported) return __error("Capability error: " + removal.unsupported + " Nothing was removed; remove effects in Effect Controls.", failureReceipt);
          if (removal.failures.length && removal.nothingRemoved) return __error(removal.mutationAttempted === false ? "Capability error: Premiere exposes neither Component.remove() nor a matching QE component for " + effectName + ". The effect was not removed; remove it in Effect Controls." : (failureReceipt.mutationOutcome === "not_applied" ? "Premiere refused the removal; the clip's components are unchanged." : "A removal was attempted, but Premiere did not confirm completion." + uncertainty + " Inspect the component stack before any retry."), failureReceipt);
          if (!removal.verified) return __error((removal.remaining.join("|") === removal.before.join("|") ? "Premiere's removal did not take effect: the clip still has " : "Premiere's removal did not take effect as expected: the clip's components read back as ") + removal.remaining.join(", ") + "." + uncertainty + " Inspect Effect Controls.", failureReceipt);
          if (removal.failures.length) return __error("Premiere could not remove " + effectName + " from this clip; it is still present. Inspect Effect Controls.", failureReceipt);
          return __result({ removed: true, verified: true, effect: effectName, remaining: removal.remaining });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    list_available_effects: {
      description: "List available video effects in Premiere Pro. Uses the full QE catalog when exposed; otherwise returns a verified, explicitly partial set of common effects resolved by exact name.",
      parameters: {},
      handler: async () => {
        const script = buildToolScript(`
          app.enableQE();
          var list = [];
          var effectCatalog = __getQeEffectCatalog("video");
          if (effectCatalog.ok) {
            var effects = effectCatalog.effects;
            for (var i = 0; i < effects.numItems; i++) {
              list.push({ name: effects[i].name, index: i, source: "qe.catalog" });
            }
            return __result(list);
          }

          // Keep this bounded and label every result as partial. It is a
          // usability fallback, not a claim that these are all installed
          // effects or that their localized display names are exhaustive.
          var commonNames = ["Transform", "Gaussian Blur", "Lumetri Color", "Crop", "Warp Stabilizer", "Tint", "Brightness & Contrast", "Ultra Key"];
          for (var probeIndex = 0; probeIndex < commonNames.length; probeIndex++) {
            var candidate = null;
            try { candidate = qe.project.getVideoEffectByName(commonNames[probeIndex]); } catch (probeError) {}
            if (candidate) list.push({ name: commonNames[probeIndex], index: null, source: "qe.byName.partial" });
          }
          if (list.length === 0) return __error(effectCatalog.error + " Direct lookup did not resolve any bounded fallback effects.");
          return __result(list);
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    list_available_audio_effects: {
      description: "List all available audio effects in Premiere Pro. Uses QE DOM.",
      parameters: {},
      handler: async () => {
        const script = buildToolScript(`
          app.enableQE();
          var effectCatalog = __getQeEffectCatalog("audio");
          if (!effectCatalog.ok) return __refuse(effectCatalog.error);
          var effects = effectCatalog.effects;
          var list = [];
          for (var i = 0; i < effects.numItems; i++) {
            list.push({ name: effects[i].name, index: i });
          }
          return __result(list);
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    list_audio_track_effects: {
      description: "List an audio track's Audio Track Mixer components (track inserts such as an added Highpass, plus any components the track itself carries), read through the undocumented QE DOM's track getComponentAt(). EXPERIMENTAL. Each component has its full name (Premiere 27.0 names an insert 'Fx Slot 1: Highpass'), the plain effectName inside it, its insert slot (1-5, null for components that are not inserts), params (the QE parameter names, e.g. ['Bypass', 'Cutoff'], null when unreadable), and bypassed (its Bypass parameter, null when unavailable). freeSlots lists the empty insert slots. builtIn marks names this server never removes. These are track-level, not clip effects; use list_clip_effects for a clip.",
      parameters: {
        type: "object" as const,
        properties: {
          track_index: TRACK_INDEX_PARAMETER,
        },
        required: ["track_index"],
      },
      handler: async (args: { track_index: number }) => {
        if (invalidTrackIndex(args.track_index)) return { success: false, error: "track_index must be a non-negative integer" };
        const script = buildToolScript(`
          ${audioTrackPrelude(args.track_index)}
          var read = __qeTrackComponents(qeTrack);
          if (!read) return __error("Capability error: QE cannot list audio track " + trackIndex + "'s components in this Premiere build (no getComponentAt(), or an unreadable component).");
          var components = [];
          for (var i = 0; i < read.names.length; i++) {
            var parts = __trackInsertParts(read.names[i]);
            var component = null;
            try { component = qeTrack.getComponentAt(i); } catch (eAt) {}
            var state = __trackInsertParams(component);
            components.push({ index: i, name: read.names[i], effectName: parts.effectName, slot: parts.slot, builtIn: __isBuiltInTrackComponentName(parts.effectName), params: state.params, bypassed: state.bypassed });
          }
          var slots = __trackInsertSlots(read.names);
          var freeSlots = [];
          for (var s = 1; s <= __TRACK_INSERT_SLOTS; s++) if (slots[s] === undefined) freeSlots.push(s);
          return __result({ trackIndex: trackIndex, trackName: trackName, count: read.names.length, countSource: read.countSource, components: components, insertSlots: __TRACK_INSERT_SLOTS, freeSlots: freeSlots, scope: "track" });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    add_audio_track_effect: {
      description: "Add an audio effect as a track insert on one audio track (an Audio Track Mixer effect slot, applied to everything on the track), not to its clips. EXPERIMENTAL: uses the undocumented QE DOM's audio track addAudioEffect(effect, slotIndex, false) (the third argument's meaning is unknown and is always false), resolving the name among audio effects only, and verifies by reading the track's QE components back (not rendered audio). A track has five insert slots and audio flows through them in slot order. Without slot, the effect goes in the first free slot, so build a chain by adding in signal order (Highpass, then DeNoise, then Parametric Equalizer) without passing slot. A slot that already holds an insert is refused unless replace: true, which replaces that insert (Premiere's own behavior for an occupied slot); a track with all five slots full is refused with nothing changed. Verified means the effect reads back as 'Fx Slot <slot>: <name>' and nothing else on the track changed. To switch an insert off without removing it, use set_audio_track_effect_bypass. Script removal is not available: on Premiere 27.0 QE ignores remove() on track inserts, so remove the insert by hand in the Audio Track Mixer, or reverse this call with undo. Do not pass undoSteps as an undo count (one Premiere 27.0 add recorded two stack entries that a single undo reversed): pass the result's undo hint (expected_undo_stack_index and undo_to_stack_index) to the undo tool, which lands exactly on the index before the add. undoStackEntries reports the entries recorded. For per-clip effects use apply_audio_effect or batch_apply_effect.",
      parameters: {
        type: "object" as const,
        properties: {
          track_index: TRACK_INDEX_PARAMETER,
          effect_name: {
            type: "string",
            description: "Display name of the audio effect (e.g., 'Highpass', 'DeNoise', 'Parametric Equalizer')",
          },
          slot: {
            type: "number",
            description: "Optional insert slot 1-5, as the Audio Track Mixer numbers them. Omit to use the first free slot (the usual choice when building a chain in order).",
          },
          replace: {
            type: "boolean",
            description: "Replace the insert already in slot. Required to add into an occupied slot; without it an occupied slot is refused with nothing changed. Default false.",
          },
        },
        required: ["track_index", "effect_name"],
      },
      handler: async (args: { track_index: number; effect_name: string; slot?: number; replace?: boolean }) => {
        if (invalidTrackIndex(args.track_index)) return { success: false, error: "track_index must be a non-negative integer" };
        if (typeof args.effect_name !== "string" || !args.effect_name.trim()) return { success: false, error: "effect_name must not be empty" };
        if (args.slot !== undefined && invalidInsertSlot(args.slot)) return { success: false, error: `slot must be an integer from 1 to ${TRACK_INSERT_SLOTS}` };
        if (args.replace !== undefined && typeof args.replace !== "boolean") return { success: false, error: "replace must be a boolean" };
        const script = buildToolScript(`
          ${audioTrackPrelude(args.track_index)}
          var effectName = "${escapeForExtendScript(args.effect_name)}";
          var requestedSlot = ${args.slot === undefined ? "null" : args.slot};
          var replace = ${args.replace === true};
          var canAdd = false;
          try { canAdd = typeof qeTrack.addAudioEffect === "function"; } catch (eCanAdd) {}
          if (!canAdd) return __refuse("Capability error: this Premiere build's QE audio track has no addAudioEffect(); nothing was changed.");
          var before = __qeTrackComponents(qeTrack);
          if (!before) return __refuse("Capability error: QE cannot list audio track " + trackIndex + "'s components, so a track insert could not be verified; nothing was changed.");
          var slots = __trackInsertSlots(before.names);
          var slot = requestedSlot;
          if (slot === null) {
            for (var s = 1; s <= __TRACK_INSERT_SLOTS; s++) if (slots[s] === undefined) { slot = s; break; }
            if (slot === null) return __refuse("All " + __TRACK_INSERT_SLOTS + " insert slots of audio track " + trackIndex + " are full (" + before.names.join(", ") + "). Nothing was changed. Pass slot with replace: true to replace one insert.", { slots: slots });
          }
          var replacing = slots[slot] !== undefined ? slots[slot] : null;
          if (replacing !== null && !replace) return __refuse("Slot " + slot + " of audio track " + trackIndex + " already holds " + replacing + ". Nothing was changed. Omit slot to use the first free slot, or pass replace: true to replace it.", { slot: slot, occupiedBy: replacing });
          if (replacing !== null && __trackInsertParts(replacing).effectName === effectName) return __refuse("Slot " + slot + " of audio track " + trackIndex + " already holds " + effectName + "; replacing an insert with the same effect changes nothing in Premiere, so nothing was done.", { slot: slot, occupiedBy: replacing });
          var effect = __qeEffectByName("audio", effectName);
          if (!effect) {
            if (__qeEffectByName("video", effectName)) return __refuse(effectName + " is a video effect, not an audio effect; nothing was changed.");
            return __refuse("Audio effect not found: " + effectName + ". Nothing was changed.");
          }
          var expectedName = "Fx Slot " + slot + ": " + effectName;
          var addError = "";
          // Premiere 27.0: arg 2 is the 0-based slot (one arg means slot 0, replacing
          // what is there); arg 3's meaning is unmeasured and false is what was tested.
          try { qeTrack.addAudioEffect(effect, slot - 1, false); } catch (eAdd) { addError = String(eAdd); }
          var receipt = __trackComponentReceipt(before, __qeTrackComponents(readQeTrack()), addError !== "", function (added, removed) {
            if (added.length !== 1 || added[0] !== expectedName) return false;
            return replacing === null ? removed.length === 0 : removed.length === 1 && removed[0] === replacing;
          });
          if (addError) receipt.hostError = addError;
          receipt.trackIndex = trackIndex;
          receipt.effect = effectName;
          receipt.slot = slot;
          receipt.replaced = replacing;
          receipt.scope = "track";
          receipt.undoStackEntries = receipt.evidence.undoSteps;
          var undoHint = __trackUndoHint();
          if (undoHint) receipt.undo = undoHint;
          if (receipt.mutationOutcome === "verified") {
            receipt.verified = true;
            receipt.outcome = "verified";
            var addedIndex = -1;
            for (var a = 0; a < receipt.evidence.after.length; a++) if (receipt.evidence.after[a] === expectedName) { addedIndex = a; break; }
            receipt.addedComponent = { index: addedIndex, name: expectedName, effectName: effectName, slot: slot };
            receipt.verificationScope = "QE track component readback only; verify rendered audio before delivery.";
            return __result(receipt);
          }
          if (receipt.mutationOutcome === "not_applied") return __error("Premiere added no insert to slot " + slot + " of audio track " + trackIndex + (addError ? " (" + addError + ")" : "") + "; the track's components are unchanged.", receipt);
          return __error("Adding " + effectName + " to slot " + slot + " of audio track " + trackIndex + " was not verified" + (receipt.uncertainty ? ": " + receipt.uncertainty : "; the track's components changed differently than expected (wanted " + expectedName + (replacing ? " in place of " + replacing : "") + ").") + " Inspect the Audio Track Mixer before any retry.", receipt);
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    set_audio_track_effect_bypass: {
      description: "Bypass (switch off) or re-enable one track insert on an audio track, leaving it in its Audio Track Mixer slot. EXPERIMENTAL: uses the undocumented QE DOM's track component setParamValue('Bypass', 'true'|'false', '0') and verifies by reading getParamValue('Bypass') back (not rendered audio). This is the in-tool way to take an insert out of the signal, since script removal does not work on Premiere 27.0. Name the insert by slot (1-5, from list_audio_track_effects) or by effect_name; give slot when the name appears in more than one slot. An insert whose QE params lack Bypass is a capability error with nothing changed. An insert already in the requested state is reported verified with changed: false and no host call. Reverse it by calling this again with the opposite value, or with undo and the result's undo hint.",
      parameters: {
        type: "object" as const,
        properties: {
          track_index: TRACK_INDEX_PARAMETER,
          slot: {
            type: "number",
            description: "Insert slot 1-5 as list_audio_track_effects reports it. Give slot, effect_name, or both (then they must agree).",
          },
          effect_name: {
            type: "string",
            description: "Effect name of the insert ('Highpass') or its full component name ('Fx Slot 1: Highpass'). Refused as ambiguous when it is in more than one slot.",
          },
          bypassed: {
            type: "boolean",
            description: "true bypasses the insert; false re-enables it",
          },
        },
        required: ["track_index", "bypassed"],
      },
      handler: async (args: { track_index: number; slot?: number; effect_name?: string; bypassed: boolean }) => {
        if (invalidTrackIndex(args.track_index)) return { success: false, error: "track_index must be a non-negative integer" };
        if (args.slot !== undefined && invalidInsertSlot(args.slot)) return { success: false, error: `slot must be an integer from 1 to ${TRACK_INSERT_SLOTS}` };
        if (args.effect_name !== undefined && (typeof args.effect_name !== "string" || !args.effect_name.trim())) return { success: false, error: "effect_name must not be empty" };
        if (args.slot === undefined && args.effect_name === undefined) return { success: false, error: "Give slot or effect_name to name the insert" };
        if (typeof args.bypassed !== "boolean") return { success: false, error: "bypassed must be a boolean" };
        const script = buildToolScript(`
          ${audioTrackPrelude(args.track_index)}
          var wantedSlot = ${args.slot === undefined ? "null" : args.slot};
          var effectName = ${args.effect_name === undefined ? "null" : `"${escapeForExtendScript(args.effect_name)}"`};
          var bypassed = ${args.bypassed};
          var bypassValue = "${args.bypassed ? "true" : "false"}";
          var wanted = wantedSlot !== null ? "slot " + wantedSlot + (effectName !== null ? " (" + effectName + ")" : "") : effectName;
          var before = __qeTrackComponents(qeTrack);
          if (!before) return __refuse("Capability error: QE cannot list audio track " + trackIndex + "'s components; nothing was changed.");
          var matches = [];
          for (var i = 0; i < before.names.length; i++) {
            var parts = __trackInsertParts(before.names[i]);
            if (parts.slot === null) continue;
            if (wantedSlot !== null && parts.slot !== wantedSlot) continue;
            if (effectName !== null && !__trackInsertNameMatches(before.names[i], effectName)) continue;
            matches.push(i);
          }
          if (!matches.length) return __refuse("Audio track " + trackIndex + " has no track insert at " + wanted + "; its components are " + before.names.join(", ") + ". Nothing was changed.");
          if (matches.length > 1) {
            var inSlots = [];
            for (var m = 0; m < matches.length; m++) inSlots.push(__trackInsertParts(before.names[matches[m]]).slot);
            return __refuse("Audio track " + trackIndex + " has " + effectName + " in slots " + inSlots.join(", ") + "; pass slot to choose one. Nothing was changed.");
          }
          var at = matches[0];
          var componentName = before.names[at];
          var componentParts = __trackInsertParts(componentName);
          var component = null;
          var liveName = null;
          try { component = qeTrack.getComponentAt(at); liveName = component ? String(component.name) : null; } catch (eAt) {}
          if (liveName !== componentName) return __refuse("Audio track " + trackIndex + "'s component " + at + " no longer reads as " + componentName + "; nothing was changed.");
          var receipt = { trackIndex: trackIndex, slot: componentParts.slot, effect: componentParts.effectName, component: componentName, index: at, scope: "track", bypassed: bypassed };
          var state = __trackInsertParams(component);
          if (!state.params) { receipt.capability = "track_insert_bypass_unavailable"; return __refuse("Capability error: QE exposes no readable getParamList() on " + componentName + ", so its Bypass cannot be set by script. Nothing was changed; toggle it in the Audio Track Mixer.", receipt); }
          var hasBypass = false;
          for (var p = 0; p < state.params.length; p++) if (state.params[p] === "Bypass") hasBypass = true;
          receipt.params = state.params;
          if (!hasBypass) { receipt.capability = "track_insert_bypass_unavailable"; return __refuse("Capability error: " + componentName + " has no Bypass parameter (its QE params are " + state.params.join(", ") + "). Nothing was changed; toggle it in the Audio Track Mixer.", receipt); }
          var canSet = false;
          try { canSet = typeof component.setParamValue === "function"; } catch (eCanSet) {}
          if (!canSet) { receipt.capability = "track_insert_bypass_unavailable"; return __refuse("Capability error: QE exposes no setParamValue() on " + componentName + ". Nothing was changed; toggle it in the Audio Track Mixer.", receipt); }
          if (state.bypassed === null) return __refuse("The Bypass state of " + componentName + " could not be read, so a change could not be verified. Nothing was changed.", receipt);
          receipt.previouslyBypassed = state.bypassed;
          if (state.bypassed === bypassed) {
            receipt.changed = false;
            receipt.verified = true;
            receipt.outcome = "verified";
            receipt.verificationScope = "QE getParamValue('Bypass') readback; no host call was made.";
            return __result(receipt);
          }
          var setError = "";
          var hostReturn = null;
          // Premiere 27.0 throws "Illegal Parameter type" unless all three args are strings.
          try { hostReturn = component.setParamValue("Bypass", bypassValue, "0"); } catch (eSet) { setError = String(eSet); }
          var after = null;
          try {
            var trackAgain = readQeTrack();
            var again = trackAgain ? trackAgain.getComponentAt(at) : null;
            if (again && String(again.name) === componentName) after = __trackInsertParams(again).bypassed;
          } catch (eAfter) { after = null; }
          var undoNow = __undoStart !== null ? __readUndoIndex() : null;
          var undoKnown = __undoStart !== null && undoNow !== null;
          var undoMoved = undoKnown && undoNow !== __undoStart;
          receipt.evidence = { before: state.bypassed, after: after, hostReturn: hostReturn === null || hostReturn === undefined ? null : String(hostReturn), undoSteps: undoKnown ? undoNow - __undoStart : null };
          if (setError) receipt.hostError = setError;
          var undoHint = __trackUndoHint();
          if (undoHint) receipt.undo = undoHint;
          if (after === bypassed) {
            receipt.changed = true;
            receipt.timelineChanged = true;
            if (!setError) {
              receipt.mutationOutcome = "verified";
              receipt.verified = true;
              receipt.outcome = "verified";
              receipt.verificationScope = "QE getParamValue('Bypass') readback only; verify rendered audio before delivery.";
              return __result(receipt);
            }
            receipt.mutationOutcome = "committed_unverified";
            return __error("Premiere threw while setting Bypass on " + componentName + " (" + setError + "), but it reads back " + bypassValue + ". Inspect the Audio Track Mixer before relying on it.", receipt);
          }
          if (!undoMoved && (after === state.bypassed || (after === null && undoKnown))) {
            receipt.mutationOutcome = "not_applied";
            receipt.timelineChanged = false;
            return __error("Premiere did not change Bypass on " + componentName + (setError ? " (" + setError + ")" : "") + "; it is still " + (state.bypassed ? "bypassed" : "active") + ". Nothing was changed.", receipt);
          }
          receipt.mutationOutcome = "unknown";
          receipt.timelineChanged = null;
          receipt.uncertainty = after === null ? "The Bypass state could not be read back after the call." : "Bypass reads back unchanged, but Premiere recorded " + (undoNow - __undoStart) + " undo step(s), so something else may have changed.";
          return __error("Setting Bypass on " + componentName + " was not verified: " + receipt.uncertainty + " Inspect the Audio Track Mixer before any retry.", receipt);
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    remove_audio_track_effect: {
      description: "Try to remove one track insert from an audio track (Audio Track Mixer effect slot) and verify by reading the track's QE components back. EXPERIMENTAL: uses the undocumented QE DOM's track getComponentAt(i).remove(). On Premiere 27.0 that remove() exists but is ignored, so this returns a capability error with nothing changed. To take an insert out of the signal in-tool, bypass it with set_audio_track_effect_bypass; to really remove it, use the Audio Track Mixer by hand, or reverse add_audio_track_effect with undo and its undo hint. It verifies and succeeds only on a build where the removal really happens. Accepts the effect name the add took ('Highpass') or the full component name ('Fx Slot 1: Highpass'). Built-in track components are refused. Takes the last instance when names repeat unless index (from list_audio_track_effects) is given.",
      parameters: {
        type: "object" as const,
        properties: {
          track_index: TRACK_INDEX_PARAMETER,
          effect_name: {
            type: "string",
            description: "Effect name of the insert (as add_audio_track_effect took it, e.g. 'Highpass') or its full component name from list_audio_track_effects (e.g. 'Fx Slot 1: Highpass')",
          },
          index: {
            type: "number",
            description: "Optional component index from list_audio_track_effects; the component there must match effect_name",
          },
        },
        required: ["track_index", "effect_name"],
      },
      handler: async (args: { track_index: number; effect_name: string; index?: number }) => {
        if (invalidTrackIndex(args.track_index)) return { success: false, error: "track_index must be a non-negative integer" };
        if (typeof args.effect_name !== "string" || !args.effect_name.trim()) return { success: false, error: "effect_name must not be empty" };
        if (args.index !== undefined && invalidTrackIndex(args.index)) return { success: false, error: "index must be a non-negative integer" };
        const script = buildToolScript(`
          ${audioTrackPrelude(args.track_index)}
          var effectName = "${escapeForExtendScript(args.effect_name)}";
          var wantedIndex = ${args.index === undefined ? "null" : args.index};
          if (__isBuiltInTrackComponentName(__trackInsertParts(effectName).effectName)) return __refuse(effectName + " is a built-in track component, not a track insert, and cannot be removed.");
          var before = __qeTrackComponents(qeTrack);
          if (!before) return __refuse("Capability error: QE cannot list audio track " + trackIndex + "'s components; nothing was changed.");
          var at = -1;
          if (wantedIndex !== null) {
            if (wantedIndex >= before.names.length || !__trackInsertNameMatches(before.names[wantedIndex], effectName)) return __refuse("Audio track " + trackIndex + " has no " + effectName + " at index " + wantedIndex + "; its components are " + before.names.join(", ") + ". Nothing was changed.");
            at = wantedIndex;
          } else {
            for (var i = before.names.length - 1; i >= 0; i--) if (__trackInsertNameMatches(before.names[i], effectName)) { at = i; break; }
            if (at < 0) return __refuse("Audio track " + trackIndex + " has no insert named " + effectName + "; its components are " + before.names.join(", ") + ". Nothing was changed.");
          }
          var component = null;
          try { component = qeTrack.getComponentAt(at); } catch (eAt) {}
          var componentName = before.names[at];
          if (!component || String(component.name) !== componentName) return __refuse("Audio track " + trackIndex + "'s component " + at + " no longer reads as " + effectName + "; nothing was changed.");
          if (typeof component.remove !== "function") return __refuse("Capability error: this Premiere build's QE exposes no remove() on audio track components, so track inserts cannot be removed by script. Nothing was changed; bypass it with set_audio_track_effect_bypass, remove it in the Audio Track Mixer, or undo the add.", { capability: "track_insert_removal_unavailable" });
          var removeError = "";
          try { component.remove(); } catch (eRemove) { removeError = String(eRemove); }
          var receipt = __trackComponentReceipt(before, __qeTrackComponents(readQeTrack()), removeError !== "", function (added, removed) { return added.length === 0 && removed.length === 1 && removed[0] === componentName; });
          if (removeError) receipt.hostError = removeError;
          receipt.trackIndex = trackIndex;
          receipt.effect = __trackInsertParts(componentName).effectName;
          receipt.component = componentName;
          receipt.index = at;
          receipt.slot = __trackInsertParts(componentName).slot;
          receipt.scope = "track";
          var undoHint = __trackUndoHint();
          if (undoHint) receipt.undo = undoHint;
          if (receipt.mutationOutcome === "verified") {
            receipt.verified = true;
            receipt.outcome = "verified";
            receipt.remaining = receipt.evidence.after;
            return __result(receipt);
          }
          if (receipt.mutationOutcome === "not_applied") {
            receipt.capability = "track_insert_removal_unavailable";
            return __error("Capability error: Premiere " + (removeError ? "refused QE remove() (" + removeError + ")" : "ignored QE remove()") + " on " + componentName + ", so this build cannot remove audio track inserts by script; audio track " + trackIndex + "'s components are unchanged. To switch it off in-tool, bypass it with set_audio_track_effect_bypass" + (receipt.slot !== null ? " (slot " + receipt.slot + ")" : "") + "; to remove it, use the Audio Track Mixer by hand, or reverse add_audio_track_effect with undo and its undo hint.", receipt);
          }
          return __error("Removing " + effectName + " from audio track " + trackIndex + " was not verified" + (receipt.uncertainty ? ": " + receipt.uncertainty : "; the track's components changed unexpectedly.") + " Inspect the Audio Track Mixer before any retry.", receipt);
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    color_correct: {
      description: "Apply basic color correction through experimental QE Lumetri insertion. Requires Lumetri component and requested property readback; rendered output is not verified.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          exposure: { type: "number", description: "Exposure adjustment (-4.0 to 4.0)" },
          contrast: { type: "number", description: "Contrast adjustment (-100 to 100)" },
          highlights: { type: "number", description: "Highlights adjustment (-100 to 100)" },
          shadows: { type: "number", description: "Shadows adjustment (-100 to 100)" },
          whites: { type: "number", description: "Whites adjustment (-100 to 100)" },
          blacks: { type: "number", description: "Blacks adjustment (-100 to 100)" },
          temperature: { type: "number", description: "Color temperature adjustment" },
          tint: { type: "number", description: "Tint adjustment" },
          saturation: { type: "number", description: "Saturation (0-200, 100 = normal)" },
        },
        required: ["node_id"],
      },
      handler: async (args: {
        node_id: string;
        exposure?: number;
        contrast?: number;
        highlights?: number;
        shadows?: number;
        whites?: number;
        blacks?: number;
        temperature?: number;
        tint?: number;
        saturation?: number;
      }) => {
        // Resolve color_correct controls only within Lumetri Basic Correction.
        const controls: Array<{ key: string; label: string; value: number }> = (
          [
            { key: "exposure", label: "Exposure", value: args.exposure },
            { key: "contrast", label: "Contrast", value: args.contrast },
            { key: "highlights", label: "Highlights", value: args.highlights },
            { key: "shadows", label: "Shadows", value: args.shadows },
            { key: "whites", label: "Whites", value: args.whites },
            { key: "blacks", label: "Blacks", value: args.blacks },
            { key: "temperature", label: "Temperature", value: args.temperature },
            { key: "tint", label: "Tint", value: args.tint },
            { key: "saturation", label: "Saturation", value: args.saturation },
          ] as Array<{ key: string; label: string; value: number | undefined }>
        ).filter((c): c is { key: string; label: string; value: number } => c.value !== undefined);

        if (!controls.length) return { success: false, error: "Specify at least one color correction value; nothing was changed." };
        if (controls.some((control) => !Number.isFinite(control.value))) return { success: false, error: "Color correction values must be finite numbers; nothing was changed." };

        const setters = controls
          .map(
            (c) => `
              if (!taken.${c.key} && name === "${c.label}") {
                try {
                  writeAttempted = true;
                  prop.setValue(${c.value}, true);
                  var observed = Number(prop.getValue());
                  if (!isFinite(observed) || Math.abs(observed - ${c.value}) > 0.001) {
                    errors.${c.key} = "Premiere did not read back the requested value";
                  } else {
                    taken.${c.key} = true;
                    changes.${c.key} = observed;
                    delete errors.${c.key};
                  }
                } catch(e) {
                  errors.${c.key} = e.toString();
                }
              }`
          )
          .join("");

        // First apply Lumetri Color effect, then set its properties
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __refuse("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __refuse("Clip not found");
          
          // Apply Lumetri Color if not already present
          var clip = result.clip;
          var hasLumetri = false;
          var lumetri = null;
          for (var i = 0; i < clip.components.numItems; i++) {
            if (clip.components[i].displayName === "Lumetri Color") {
              hasLumetri = true;
              lumetri = clip.components[i];
              break;
            }
          }

          var qeAttempted = false;
          var qeAddError = "";
          if (!hasLumetri) {
            var qeTrack = qeSeq.getVideoTrackAt(result.trackIndex);
            // QE track items include gaps, so the DOM clip index is not a QE index.
            var qeClip = __findQeClipByDomClip(qeTrack, clip);
            if (!qeClip) return __error("Could not match the QE clip for " + clip.name + " by timeline start; nothing was changed.");
            var effectCatalog = __getQeEffectCatalog("video");
            if (!effectCatalog.ok) return __error(effectCatalog.error);
            var effects = effectCatalog.effects;
            var qeEffect = null;
            for (var i = 0; i < effects.numItems; i++) {
              if (effects[i].name === "Lumetri Color") {
                qeEffect = __qeEffectObject("video", effects[i]);
                break;
              }
            }
            if (!qeEffect) return __error("The QE video-effect catalog does not contain Lumetri Color; nothing was changed.");
            qeAttempted = true;
            try { qeClip.addVideoEffect(qeEffect); } catch (eAdd) { qeAddError = String(eAdd); }
            for (var li = 0; li < clip.components.numItems; li++) {
              if (clip.components[li].displayName === "Lumetri Color") { lumetri = clip.components[li]; break; }
            }
            if (!lumetri) {
              return __jsonStringify({ success: false,
                error: "Premiere did not expose a Lumetri Color component after the QE add attempt; color correction was not verified. Inspect the clip before retrying.",
                data: { colorCorrected: false, verified: false, renderVerified: false,
                  timelineChanged: true, outcome: "committed_unverified", hostError: qeAddError } });
            }
          }

          var sectionHeaderNames = ${JSON.stringify(LUMETRI_SECTION_HEADER_NAMES)};
          var basicCorrectionHeaderName = sectionHeaderNames[0];
          var correctionStart = -1;
          var correctionEnd = lumetri.properties.numItems;
          for (var sectionIndex = 0; sectionIndex < lumetri.properties.numItems; sectionIndex++) {
            if (String(lumetri.properties[sectionIndex].displayName) === basicCorrectionHeaderName) { correctionStart = sectionIndex + 1; break; }
          }
          // If Basic Correction is unavailable, retain the prior whole-component
          // lookup and ambiguity refusal instead of guessing a section boundary.
          var controlStart = correctionStart >= 0 ? correctionStart : 0;
          if (correctionStart >= 0) {
            for (var nextHeaderIndex = correctionStart; nextHeaderIndex < lumetri.properties.numItems; nextHeaderIndex++) {
              var nextHeaderName = String(lumetri.properties[nextHeaderIndex].displayName);
              var isSectionHeader = false;
              for (var headerIndex = 0; headerIndex < sectionHeaderNames.length; headerIndex++) {
                if (nextHeaderName === sectionHeaderNames[headerIndex]) { isSectionHeader = true; break; }
              }
              if (isSectionHeader) { correctionEnd = nextHeaderIndex; break; }
            }
          }
          var ambiguousControls = [];
          var missingControls = [];
          for (var controlIndex = 0; controlIndex < ${controls.length}; controlIndex++) {
            var control = [${controls.map((c) => `"${c.label}"`).join(",")}][controlIndex];
            var candidateIndices = [];
            for (var propertyIndex = controlStart; propertyIndex < correctionEnd; propertyIndex++) {
              if (String(lumetri.properties[propertyIndex].displayName) === control) candidateIndices.push(propertyIndex);
            }
            if (candidateIndices.length > 1) ambiguousControls.push(control + " at property indices [" + candidateIndices.join(", ") + "]");
            else if (candidateIndices.length === 0) missingControls.push(control);
          }
          if (ambiguousControls.length || missingControls.length) {
            return __jsonStringify({ success: false,
              error: (ambiguousControls.length ? "Lumetri property names are ambiguous: " + ambiguousControls.join("; ") + ". " : "") +
                (missingControls.length ? "Lumetri Basic Correction properties were not found: " + missingControls.join(", ") + ". " : "") +
                "Use set_effect_property with property_index from get_effect_properties.",
              data: { colorCorrected: false, verified: false, renderVerified: false, timelineChanged: qeAttempted, outcome: qeAttempted ? "committed_unverified" : "not_applied", errors: {}, changes: {} } });
          }

          // A single unsettable property must not abort the script with "Invalid
          // parameter" and lose every other change, so each write is guarded.
          // The taken map is a separate set of flags rather than a truthiness check on
          // changes: 0 is a legitimate value (saturation 0 is a valid full desaturate),
          // and a falsy check would re-fire it on every later sub-section that repeats
          // the same display name.
          var changes = {};
          var errors = {};
          var taken = {};
          var writeAttempted = false;

          try {
            for (var p = controlStart; p < correctionEnd; p++) {
              var prop = lumetri.properties[p];
              var name = prop.displayName;
              ${setters}
            }
          } catch (propertyError) { errors.properties = String(propertyError); }
          var changeCount = 0;
          ${controls.map((control) => `if (!taken.${control.key} && !errors.${control.key}) errors.${control.key} = "Requested Lumetri property was not found or writable";`).join("\n")}
          for (var changedKey in changes) if (changes.hasOwnProperty(changedKey)) changeCount++;
          if (changeCount !== ${controls.length} || qeAddError) {
            var mutationAttempted = qeAttempted || writeAttempted;
            return __jsonStringify({ success: false,
              error: mutationAttempted
                ? "Lumetri Color did not read back every requested value; the timeline may have changed. Inspect the clip before retrying."
                : "No requested Lumetri control was found or writable; nothing was changed.",
              data: { colorCorrected: false, verified: false, renderVerified: false,
                timelineChanged: mutationAttempted, outcome: mutationAttempted ? "committed_unverified" : "not_applied",
                clipName: clip.name, changes: changes, errors: errors, hostError: qeAddError } });
          }
          return __result({ colorCorrected: true, verified: true, renderVerified: false,
            verificationScope: "Lumetri component and property readback only; inspect rendered output before delivery.",
            clipName: clip.name, changes: changes, errors: errors });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    apply_lut: {
      description:
        "Unavailable on the CEP backend: Premiere's scripting API cannot load a LUT file into Lumetri Color. Its Input LUT and Look parameters are menu indexes over a curated set of bundled looks, and writing a file path to the LUT asset parameters is accepted but not rendered (seen on Premiere Pro 25.2.3, macOS, by comparing exported frames with the same LUT applied by ffmpeg; other builds were not tested). Fails before changing the clip. Apply the LUT in Lumetri Color > Creative > Look (Browse...) instead.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip",
          },
          lut_path: {
            type: "string",
            description: "Full path to the .cube or .3dl LUT file",
          },
        },
        required: ["node_id", "lut_path"],
      },
      handler: async (args: { node_id: string; lut_path: string }) => {
        void args;
        return {
          success: false,
          error:
            "Premiere's scripting API cannot apply a LUT file: Lumetri's Input LUT and Look are menu indexes, and a file path written to the LUT asset parameters is accepted but not rendered (seen on Premiere Pro 25.2.3, macOS; other builds were not tested). Nothing was changed. Apply the LUT in Lumetri Color > Creative > Look > Browse..., or use color_correct for exposure, contrast, temperature, tint, and saturation.",
        };
      },
    },

    inspect_stabilizer_status: {
      description: "Read Warp Stabilizer presence, exposed status properties, and conservative analysis state for one clip or every video clip in the active sequence. Read-only: unknown or localized host values remain unknown rather than being reported as solved.",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          node_id: { type: "string", description: "Optional clip node ID. Omit to inspect every video clip in the active sequence." },
        },
      },
      handler: async (args: { node_id?: string }) => {
        const nodeId = args.node_id ? escapeForExtendScript(args.node_id) : "";
        const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __refuse("No active sequence");
          var requestedNodeId = "${nodeId}";
          var clips = [];
          if (requestedNodeId) {
            var found = __findClip(requestedNodeId);
            if (!found || found.trackType !== "video") return __error("Video clip not found: " + requestedNodeId);
            clips.push({ clip: found.clip, trackIndex: found.trackIndex, clipIndex: found.clipIndex });
          } else {
            for (var trackIndex = 0; trackIndex < seq.videoTracks.numTracks; trackIndex++) {
              var track = seq.videoTracks[trackIndex];
              for (var clipIndex = 0; clipIndex < track.clips.numItems; clipIndex++) {
                clips.push({ clip: track.clips[clipIndex], trackIndex: trackIndex, clipIndex: clipIndex });
              }
            }
          }
          function primitiveValue(value) {
            if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
            return String(value);
          }
          var results = [];
          for (var clipCursor = 0; clipCursor < clips.length; clipCursor++) {
            var entry = clips[clipCursor];
            var stabilizer = null;
            for (var componentIndex = 0; componentIndex < entry.clip.components.numItems; componentIndex++) {
              var component = entry.clip.components[componentIndex];
              var componentName = String(component.displayName || "");
              var matchName = String(component.matchName || "");
              var identity = (componentName + " " + matchName).toLowerCase();
              if (identity.indexOf("warp stabilizer") >= 0 || identity.indexOf("warp stabiliser") >= 0) {
                stabilizer = component;
                break;
              }
            }
            if (!stabilizer) continue;
            var properties = [];
            var stateEvidence = [];
            for (var propertyIndex = 0; propertyIndex < stabilizer.properties.numItems; propertyIndex++) {
              var property = stabilizer.properties[propertyIndex];
              var propertyName = String(property.displayName || "");
              var propertyValue = null;
              var readable = true;
              try { propertyValue = primitiveValue(property.getValue()); } catch (readError) { readable = false; }
              properties.push({ name: propertyName, value: propertyValue, readable: readable });
              var stateName = propertyName.toLowerCase();
              if (stateName.indexOf("status") >= 0 || stateName.indexOf("result") >= 0 || stateName.indexOf("analy") >= 0) {
                stateEvidence.push({ name: propertyName, value: propertyValue, readable: readable });
              }
            }
            var analysisStatus = "unknown";
            for (var evidenceIndex = 0; evidenceIndex < stateEvidence.length; evidenceIndex++) {
              var text = String(stateEvidence[evidenceIndex].value).toLowerCase();
              if (text.indexOf("not analy") >= 0 || text.indexOf("unanaly") >= 0) analysisStatus = "not_analyzed";
              else if (text.indexOf("analyzing") >= 0 || text.indexOf("analysing") >= 0 || text.indexOf("progress") >= 0) analysisStatus = "analyzing";
              else if (text.indexOf("stabilized") >= 0 || text.indexOf("stabilised") >= 0 || text.indexOf("complete") >= 0 || text.indexOf("solved") >= 0) analysisStatus = "analyzed";
            }
            results.push({
              nodeId: String(entry.clip.nodeId), clipName: String(entry.clip.name),
              trackIndex: entry.trackIndex, clipIndex: entry.clipIndex,
              componentName: String(stabilizer.displayName || "Warp Stabilizer"),
              analysisStatus: analysisStatus, stateEvidence: stateEvidence, properties: properties
            });
          }
          return __result({
            inspectedClipCount: clips.length,
            stabilizerClipCount: results.length,
            clips: results,
            verificationScope: "Read-only host property inspection. analysisStatus is conservative and remains unknown when Premiere exposes numeric, localized, absent, or unreadable state values; unknown is not proof of a completed solve."
          });
        `);
        return sendCommand(script, bridgeOptions);
      },
    },

    stabilize_clip: {
      description: "Apply Warp Stabilizer using the experimental QE DOM. Verifies component addition and readable parameter values, never analysis completion. Numeric or unreadable Method popup values remain unverified because no documented label mapping is available.",
      parameters: {
        type: "object" as const,
        properties: {
          node_id: {
            type: "string",
            description: "Node ID of the clip to stabilize",
          },
          smoothness: {
            type: "number",
            description: "Stabilization smoothness percentage (default: 50). Higher = smoother but more cropping.",
          },
          method: {
            type: "string",
            enum: ["Subspace Warp", "Position", "Position, Scale, Rotation"],
            description: "Stabilization method (default: 'Subspace Warp')",
          },
        },
        required: ["node_id"],
      },
      handler: async (args: { node_id: string; smoothness?: number; method?: string }) => {
        if (args.smoothness !== undefined && (!Number.isFinite(args.smoothness) || args.smoothness < 0 || args.smoothness > 100)) return { success: false, error: "smoothness must be a finite percentage from 0 to 100" };
        if (args.method !== undefined && !["Subspace Warp", "Position", "Position, Scale, Rotation"].includes(args.method)) return { success: false, error: "Unsupported stabilization method" };
        const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __refuse("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __refuse("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var qeTrack = result.trackType === "video"
            ? qeSeq.getVideoTrackAt(result.trackIndex)
            : null;
          if (!qeTrack) return __refuse("Warp Stabilizer can only be applied to video clips");
          
          // QE track items include gaps, so the DOM clip index is not a QE index.
          var qeClip = __findQeClipByDomClip(qeTrack, result.clip);
          if (!qeClip) return __refuse("Could not match the QE clip for " + result.clip.name + " by timeline start; nothing was changed.");

          var componentCountBefore = result.clip.components.numItems;
          if (typeof componentCountBefore !== "number" || !isFinite(componentCountBefore)) return __refuse("Cannot read clip components; nothing was changed.");
          // Find and apply Warp Stabilizer
          var effectCatalog = __getQeEffectCatalog("video");
          if (!effectCatalog.ok) return __refuse(effectCatalog.error);
          var effects = effectCatalog.effects;
          var found = false;
          for (var i = 0; i < effects.numItems; i++) {
            if (effects[i].name === "Warp Stabilizer") {
              qeClip.addVideoEffect(__qeEffectObject("video", effects[i]));
              found = true;
              break;
            }
          }
          
          if (!found) return __error("Warp Stabilizer effect not found");
          
          var clip = result.clip;
          var afterCount = null;
          var stabilizer = null;
          try {
            afterCount = clip.components.numItems;
            if (typeof afterCount !== "number" || !isFinite(afterCount)) afterCount = null;
            if (afterCount !== null) {
              for (var componentIndex = componentCountBefore; componentIndex < afterCount; componentIndex++) {
                if (clip.components[componentIndex].displayName === "Warp Stabilizer") stabilizer = clip.components[componentIndex];
              }
            }
          } catch (componentReadError) { afterCount = null; }
          var changes = { stabilized: false };
          var data = { clipName: clip.name, changes: changes, requested: { smoothness: ${args.smoothness === undefined ? "null" : args.smoothness}, method: ${args.method === undefined ? "null" : `"${escapeForExtendScript(args.method)}"`} }, applied: { smoothness: null, method: null }, componentCountBefore: componentCountBefore, componentCountAfter: afterCount, verified: false, outcome: "committed_unverified", analysisStatus: "unknown", info: "Effect and parameter readback only; analysis completion and rendered stabilization require separate inspection." };
          if (afterCount !== null && afterCount <= componentCountBefore) { data.outcome = "failed"; return __error("Premiere did not add Warp Stabilizer.", data); }
          if (!stabilizer) return __result(data);
          changes.stabilized = true;
          var parameterVerified = true;
          var parameterMismatch = false;
          var warnings = [];
          function setStabilizerParameter(name, requested, field) {
            if (requested === null) return;
            var property = null;
            var matches = 0;
            for (var propertyIndex = 0; propertyIndex < stabilizer.properties.numItems; propertyIndex++) {
              if (stabilizer.properties[propertyIndex].displayName === name) { property = stabilizer.properties[propertyIndex]; matches++; }
            }
            if (matches !== 1) { parameterVerified = false; warnings.push(name + " property is unavailable or ambiguous."); return; }
            try {
              if (name === "Method") {
                var currentMethod = property.getValue();
                if (typeof currentMethod !== "string" || (currentMethod !== "Subspace Warp" && currentMethod !== "Position" && currentMethod !== "Position, Scale, Rotation")) {
                  parameterVerified = false;
                  warnings.push("Method popup mapping is unavailable; method was not changed.");
                  return;
                }
              }
              property.setValue(requested, true);
              var actual = property.getValue();
              if (actual === undefined || actual === null || (typeof actual === "number" && !isFinite(actual))) { parameterVerified = false; return; }
              data.applied[field] = actual;
              changes[field] = actual;
              var same = typeof actual === "number" && typeof requested === "number" ? Math.abs(actual - requested) <= 0.0001 : actual === requested;
              if (!same) { parameterMismatch = true; parameterVerified = false; }
            } catch (parameterError) { parameterVerified = false; warnings.push(name + " write or readback unavailable: " + String(parameterError)); }
          }
          setStabilizerParameter("Smoothness", data.requested.smoothness, "smoothness");
          setStabilizerParameter("Method", data.requested.method, "method");
          data.warnings = warnings;
          data.verified = parameterVerified;
          data.outcome = parameterMismatch ? "failed" : (parameterVerified ? "verified" : "committed_unverified");
          if (parameterMismatch) return __error("Warp Stabilizer parameter readback does not match the requested value.", data);
          return __result(data);
        `);
        return sendCommand(script, bridgeOptions);
      },
    },
  };
}
