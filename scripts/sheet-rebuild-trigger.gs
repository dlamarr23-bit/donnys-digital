/**
 * Donny's Digital -- rebuild the site after the sheet changes.
 *
 * ADD THIS AS A NEW FILE in the sheet's Apps Script project
 * (Files -> + -> Script). Do NOT paste it into an existing file.
 *
 * Every .gs file in an Apps Script project shares ONE global namespace, so a
 * duplicate name breaks the whole project, not just this file. Every name
 * here is therefore given a "dd" prefix to stay clear of whatever script you
 * already have. There is deliberately NO onOpen in this file -- see MENU at
 * the bottom -- because onOpen is the one name you most likely already use,
 * and a second one would silently replace your existing menu.
 *
 * WHY THIS EXISTS
 * The site paints from the snapshot JSON files, built at deploy time by
 * scripts/build-data.mjs. Snapshot fresh: ~581KB, ~40ms to first paint.
 * Snapshot stale: the page falls through to the live sheet and pulls ~11MB.
 * The snapshot only rebuilds on deploy, so with the sheet edited daily it was
 * almost always stale. This rebuilds it after you edit.
 *
 * WHY IT WAITS RATHER THAN BUILDING ON EVERY EDIT
 *   1. Netlify free tier is 300 build minutes a month; one build per cell
 *      edit would exhaust that in a day.
 *   2. build-data.mjs reads the PUBLISHED csv, which lags live edits by a few
 *      minutes -- an instant build would snapshot your pre-edit data.
 * An edit only marks state dirty. A 5-minute timer builds once the sheet has
 * been quiet for DD_QUIET_MINUTES, so an editing session of any length
 * produces exactly ONE build, shortly after you stop.
 *
 * SETUP
 *   1. Netlify -> Site configuration -> Build and deploy -> Build hooks
 *      -> Add build hook. Paste the URL into DD_HOOK_URL below.
 *   2. Save, run ddInstallTriggers once, accept the permissions.
 *   3. Wire up the menu (see MENU at the bottom).
 */

// ---------------------------------------------------------------- settings --
var DD_HOOK_URL = 'PASTE_YOUR_NETLIFY_BUILD_HOOK_URL_HERE';

// Only edits on these tabs count; editing any other tab will not rebuild.
var DD_WATCH_SHEETS = ['Movies'];

// How long the sheet must be quiet before building. Also gives the published
// CSV cache time to catch up so the build sees your latest edits. Do not go
// below about 5, or you will start snapshotting stale data.
var DD_QUIET_MINUTES = 10;

// "var", not "const": if this file is ever added twice, var redeclaration is
// harmless, where a duplicate const would break every script in the project.
var DD_P_DIRTY = 'ddDirty';
var DD_P_LASTEDIT = 'ddLastEdit';
var DD_P_LASTBUILD = 'ddLastBuild';

// Installable onEdit trigger. Deliberately cheap -- it only records state.
function ddOnSheetEdit(e) {
  try {
    if (e && e.range && DD_WATCH_SHEETS.indexOf(e.range.getSheet().getName()) === -1) return;
  } catch (err) {
    // Sheet name unreadable -- fall through and treat it as a real edit.
  }
  var p = PropertiesService.getScriptProperties();
  p.setProperty(DD_P_DIRTY, '1');
  p.setProperty(DD_P_LASTEDIT, String(Date.now()));
}

// Time-driven trigger, every 5 minutes. Builds only once the edits stop.
function ddFlushBuild() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty(DD_P_DIRTY) !== '1') return;
  var idleMs = Date.now() - Number(p.getProperty(DD_P_LASTEDIT) || 0);
  if (idleMs < DD_QUIET_MINUTES * 60 * 1000) return;
  ddTriggerBuild_('sheet edit');
}

function ddTriggerBuild_(reason) {
  if (!DD_HOOK_URL || DD_HOOK_URL.indexOf('http') !== 0) {
    throw new Error('DD_HOOK_URL is not set -- paste your Netlify build hook URL at the top.');
  }
  var url = DD_HOOK_URL + (DD_HOOK_URL.indexOf('?') === -1 ? '?' : '&')
          + 'trigger_title=' + encodeURIComponent('Sheet updated (' + reason + ')');
  var res = UrlFetchApp.fetch(url, { method: 'post', payload: '', muteHttpExceptions: true });
  var code = res.getResponseCode();
  var p = PropertiesService.getScriptProperties();
  if (code >= 200 && code < 300) {
    p.setProperty(DD_P_DIRTY, '0');
    p.setProperty(DD_P_LASTBUILD, String(Date.now()));
    console.log('Netlify build triggered (' + reason + ')');
    return true;
  }
  console.error('Build hook failed: ' + code + ' ' + res.getContentText());
  return false;
}

// Run once. Safe to re-run -- it clears only its OWN triggers first.
function ddInstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'ddOnSheetEdit' || f === 'ddFlushBuild') ScriptApp.deleteTrigger(t);
  });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('ddOnSheetEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('ddFlushBuild').timeBased().everyMinutes(5).create();
  ss.toast('Auto-rebuild installed. Edits now rebuild the site about '
           + DD_QUIET_MINUTES + ' minutes after you stop.', "Donny's Digital", 8);
}

function ddRemoveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'ddOnSheetEdit' || f === 'ddFlushBuild') ScriptApp.deleteTrigger(t);
  });
  SpreadsheetApp.getActive().toast('Auto-rebuild removed.', "Donny's Digital", 5);
}

function ddRebuildNow() {
  var ok = ddTriggerBuild_('manual');
  SpreadsheetApp.getActive().toast(
    ok ? 'Build triggered. Live in about a minute.'
       : 'Build hook failed -- see the execution log.', "Donny's Digital", 6);
}

function ddShowStatus() {
  var p = PropertiesService.getScriptProperties();
  var fmt = function (v) { return v ? new Date(Number(v)).toLocaleString() : 'never'; };
  var installed = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'ddFlushBuild';
  }).length > 0;
  SpreadsheetApp.getUi().alert(
    "Donny's Digital -- auto-rebuild" + '\n\n'
    + 'Timer installed: ' + (installed ? 'yes' : 'NO -- run ddInstallTriggers') + '\n'
    + 'Pending changes: ' + (p.getProperty(DD_P_DIRTY) === '1' ? 'yes' : 'no') + '\n'
    + 'Last edit seen:  ' + fmt(p.getProperty(DD_P_LASTEDIT)) + '\n'
    + 'Last build sent: ' + fmt(p.getProperty(DD_P_LASTBUILD)) + '\n\n'
    + 'Builds fire once the sheet has been quiet for ' + DD_QUIET_MINUTES + ' minutes.');
}

// ------------------------------------------------------------------ MENU --
// Adds the menu. Call ddAddMenu() from your onOpen.
//
// If you ALREADY have an onOpen in this project, add ONE line to it. Do not
// create a second onOpen -- the last one defined silently wins:
//
//     function onOpen() {
//       ...your existing menu code...
//       ddAddMenu();
//     }
//
// If you have NO onOpen anywhere, add this to any file:
//
//     function onOpen() { ddAddMenu(); }
//
function ddAddMenu() {
  SpreadsheetApp.getUi().createMenu("Donny's Digital")
    .addItem('Rebuild site now', 'ddRebuildNow')
    .addSeparator()
    .addItem('Install auto-rebuild', 'ddInstallTriggers')
    .addItem('Remove auto-rebuild', 'ddRemoveTriggers')
    .addItem('Status', 'ddShowStatus')
    .addToUi();
}
