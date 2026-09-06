/**
 * Donny's Digital -- rebuild the site after the sheet changes.
 *
 * WHY THIS EXISTS
 * The site paints from /snapshots/*.json, which are built at deploy time by
 * scripts/build-data.mjs. When the snapshot matches the sheet, a visit costs
 * ~581KB and paints in ~40ms. When it does NOT match, the page falls through
 * to the live sheet and pulls ~11MB instead -- measured at ~741ms for the
 * snapshot path vs several seconds for the full download.
 *
 * Since the sheet is edited constantly and the snapshot only rebuilds on
 * deploy, the snapshot was almost always stale. This script rebuilds it.
 *
 * WHY IT WAITS INSTEAD OF BUILDING ON EVERY EDIT
 * Two reasons:
 *   1. Netlify's free tier includes 300 build minutes a month. One build per
 *      cell edit would exhaust that in a day.
 *   2. build-data.mjs reads the PUBLISHED csv, which lags live edits by a few
 *      minutes. Building instantly would snapshot the pre-edit data.
 * So an edit only marks the sheet dirty. A timer checks every 5 minutes and
 * builds once the sheet has been quiet for QUIET_MINUTES -- meaning a whole
 * editing session of any length produces exactly ONE build, after you stop.
 *
 * SETUP
 *   1. Netlify -> Site configuration -> Build & deploy -> Build hooks
 *      -> Add build hook. Copy the URL into HOOK_URL below.
 *   2. Save, then run installTriggers() once and accept the permissions.
 *   3. Reload the sheet; use the "Donny's Digital" menu to build on demand.
 */

// ---------------------------------------------------------------- settings --
const HOOK_URL = 'PASTE_YOUR_NETLIFY_BUILD_HOOK_URL_HERE';

// Only edits on these tabs count. Editing an unrelated tab won't rebuild.
const WATCH_SHEETS = ['Movies'];

// How long the sheet must be quiet before building. Also gives Google's
// published-CSV cache time to catch up, so the build sees your latest edits.
const QUIET_MINUTES = 10;

// ------------------------------------------------------------------ state --
const P_DIRTY = 'ddDirty';
const P_LASTEDIT = 'ddLastEdit';
const P_LASTBUILD = 'ddLastBuild';

/** Installable onEdit trigger. Deliberately cheap: it only records state. */
function onSheetEdit(e) {
  try {
    if (e && e.range && WATCH_SHEETS.indexOf(e.range.getSheet().getName()) === -1) return;
  } catch (err) {
    // If the sheet name can't be read, fall through and treat it as a real edit.
  }
  const p = PropertiesService.getScriptProperties();
  p.setProperty(P_DIRTY, '1');
  p.setProperty(P_LASTEDIT, String(Date.now()));
}

/** Time-driven trigger, every 5 minutes. Builds only once the edits stop. */
function flushBuild() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty(P_DIRTY) !== '1') return;
  const idleMs = Date.now() - Number(p.getProperty(P_LASTEDIT) || 0);
  if (idleMs < QUIET_MINUTES * 60 * 1000) return;  // still editing -- wait
  triggerBuild_('sheet edit');
}

function triggerBuild_(reason) {
  if (!HOOK_URL || HOOK_URL.indexOf('http') !== 0) {
    throw new Error('HOOK_URL is not set -- paste your Netlify build hook URL at the top.');
  }
  const url = HOOK_URL + (HOOK_URL.indexOf('?') === -1 ? '?' : '&')
            + 'trigger_title=' + encodeURIComponent('Sheet updated (' + reason + ')');
  const res = UrlFetchApp.fetch(url, { method: 'post', payload: '', muteHttpExceptions: true });
  const code = res.getResponseCode();
  const p = PropertiesService.getScriptProperties();
  if (code >= 200 && code < 300) {
    p.setProperty(P_DIRTY, '0');
    p.setProperty(P_LASTBUILD, String(Date.now()));
    console.log('Netlify build triggered (' + reason + ')');
    return true;
  }
  // Leave P_DIRTY set so the next timer tick retries.
  console.error('Build hook failed: ' + code + ' ' + res.getContentText());
  return false;
}

/** Run once. Safe to re-run -- it clears its own triggers first. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'onSheetEdit' || f === 'flushBuild') ScriptApp.deleteTrigger(t);
  });
  const ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('flushBuild').timeBased().everyMinutes(5).create();
  ss.toast('Auto-rebuild installed. Edits now rebuild the site '
           + QUIET_MINUTES + ' minutes after you stop.', "Donny's Digital", 8);
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'onSheetEdit' || f === 'flushBuild') ScriptApp.deleteTrigger(t);
  });
  SpreadsheetApp.getActive().toast('Auto-rebuild removed.', "Donny's Digital", 5);
}

function rebuildNow() {
  const ok = triggerBuild_('manual');
  SpreadsheetApp.getActive().toast(
    ok ? 'Build triggered. Live in about a minute.' : 'Build hook failed -- see the execution log.',
    "Donny's Digital", 6);
}

function showStatus() {
  const p = PropertiesService.getScriptProperties();
  const fmt = function (v) {
    return v ? new Date(Number(v)).toLocaleString() : 'never';
  };
  const installed = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'flushBuild'; }).length > 0;
  SpreadsheetApp.getUi().alert(
    "Donny's Digital -- auto-rebuild\n\n"
    + 'Timer installed: ' + (installed ? 'yes' : 'NO -- run Install auto-rebuild') + '\n'
    + 'Pending changes: ' + (p.getProperty(P_DIRTY) === '1' ? 'yes' : 'no') + '\n'
    + 'Last edit seen:  ' + fmt(p.getProperty(P_LASTEDIT)) + '\n'
    + 'Last build sent: ' + fmt(p.getProperty(P_LASTBUILD)) + '\n\n'
    + 'Builds fire once the sheet has been quiet for ' + QUIET_MINUTES + ' minutes.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Donny's Digital")
    .addItem('Rebuild site now', 'rebuildNow')
    .addSeparator()
    .addItem('Install auto-rebuild', 'installTriggers')
    .addItem('Remove auto-rebuild', 'removeTriggers')
    .addItem('Status', 'showStatus')
    .addToUi();
}
