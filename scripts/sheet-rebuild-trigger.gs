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
 *   1. Cloudflare Pages free tier is 500 builds a month; one build per cell
 *      edit would exhaust that in an afternoon.
 *   2. build-data.mjs reads the PUBLISHED csv, which lags live edits by a few
 *      minutes -- an instant build would snapshot your pre-edit data.
 * An edit only marks state dirty. A 5-minute timer builds once the sheet has
 * been quiet for DD_QUIET_MINUTES, so an editing session of any length
 * produces exactly ONE build, shortly after you stop.
 *
 * SETUP
 *   1. Cloudflare dashboard -> Workers & Pages -> donnys-digital -> Settings
 *      -> Builds & deployments -> Deploy hooks -> Add deploy hook. Point it
 *      at the "main" branch and paste the URL it gives you into DD_HOOK_URL
 *      below. Treat that URL as a password: anyone holding it can spend your
 *      build minutes, so keep it in the script and out of the repo.
 *   2. Check DD_DAILY_HOURS against when your tabs actually refresh, and check
 *      the script timezone under Project Settings. These are what keep Sales
 *      current -- see the note on them below.
 *   3. Save, run ddInstallTriggers once, accept the permissions.
 *   4. Wire up the menu (see MENU at the bottom).
 */

// ---------------------------------------------------------------- settings --
var DD_HOOK_URL = 'PASTE_YOUR_CLOUDFLARE_DEPLOY_HOOK_URL_HERE';

// Which tabs count as a change worth rebuilding for. EMPTY MEANS EVERY TAB,
// which is what you want here.
//
// This used to be ['Movies'], and that quietly broke the Sales page. The sales
// grid is built from 46 tabs -- Today, M, T, W, Th, F, Sat, Sun, their eight TV
// counterparts, ten Mix & Match and twenty Fanflix -- and not one of them is
// named "Movies". So a day of editing sales changed nothing the trigger could
// see, no build ran, and sales.html went on seeding its first paint from
// whatever bundle the last Movies edit happened to produce.
//
// Sales change daily, so this is the tab set that needs the rebuild most.
var DD_WATCH_SHEETS = [];

// How long the sheet must be quiet before building. Also gives the published
// CSV cache time to catch up so the build sees your latest edits. Do not go
// below about 5, or you will start snapshotting stale data.
var DD_QUIET_MINUTES = 10;

// ---- THE SCHEDULED BUILDS, AND WHY THEY ARE NOT OPTIONAL ----
// Everything above is driven by ddOnSheetEdit, and onEdit fires for a PERSON
// TYPING IN A CELL and for almost nothing else. A write from a script, from
// the Sheets API, from an IMPORTRANGE recalculating, or from any external
// sync leaves it completely silent -- no event, no dirty flag, no build.
//
// The sales tabs refresh themselves every day. That refresh is exactly the
// case onEdit cannot see, so the edit-driven path above is blind to the one
// update that happens every single day, and sales.html would go back to
// seeding its first paint from a bundle up to a day old.
//
// So these run unconditionally, with the dirty flag ignored on purpose: there
// is nothing to be dirty. One trigger is created per hour listed here, and the
// hours land AFTER each known update window, never during it:
//
//   06:00-07:00  the daily sales tabs refresh  ->  build at 08:00
//   12:00-13:00  MA Compare refreshes          ->  build at 14:00
//   Fanflix moves at irregular times           ->  build at 20:00 sweeps up
//
// The slack is deliberate. Apps Script fires "atHour" somewhere INSIDE that
// hour rather than on the dot, so a build at 07:00 could start at 07:50 -- or
// at 07:05, while a refresh was still finishing. On top of that the published
// CSV the build reads trails live edits by a few minutes.
//
// Each hour costs ~30 builds a month and Cloudflare's free tier allows 500,
// so adding one is cheap. Three, plus edit-driven builds, is comfortable.
//
// TIMEZONE: these are the SCRIPT's timezone, not necessarily yours. Check it
// under Project Settings in the Apps Script editor before trusting them.
var DD_DAILY_HOURS = [8, 14, 20];   // 24h clock

// "var", not "const": if this file is ever added twice, var redeclaration is
// harmless, where a duplicate const would break every script in the project.
var DD_P_DIRTY = 'ddDirty';
var DD_P_LASTEDIT = 'ddLastEdit';
var DD_P_LASTBUILD = 'ddLastBuild';

// Installable onEdit trigger. Deliberately cheap -- it only records state.
function ddOnSheetEdit(e) {
  try {
    if (e && e.range && DD_WATCH_SHEETS.length &&
        DD_WATCH_SHEETS.indexOf(e.range.getSheet().getName()) === -1) return;
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

// Time-driven. Deliberately does NOT consult DD_P_DIRTY -- the updates this
// exists to catch never set it. Every hour in DD_DAILY_HOURS points here.
function ddDailyBuild() {
  ddTriggerBuild_('scheduled');
}

function ddTriggerBuild_(reason) {
  if (!DD_HOOK_URL || DD_HOOK_URL.indexOf('http') !== 0) {
    throw new Error('DD_HOOK_URL is not set -- paste your Cloudflare deploy hook URL at the top.');
  }
  // Netlify took a ?trigger_title= to label the deploy in its UI. A Cloudflare
  // deploy hook ignores query parameters, so the reason is only recorded in
  // this script's own execution log, below.
  var res = UrlFetchApp.fetch(DD_HOOK_URL, { method: 'post', payload: '', muteHttpExceptions: true });
  var code = res.getResponseCode();
  var p = PropertiesService.getScriptProperties();
  if (code >= 200 && code < 300) {
    p.setProperty(DD_P_DIRTY, '0');
    p.setProperty(DD_P_LASTBUILD, String(Date.now()));
    console.log('Cloudflare Pages build triggered (' + reason + ')');
    return true;
  }
  console.error('Build hook failed: ' + code + ' ' + res.getContentText());
  return false;
}

// Run once. Safe to re-run -- it clears only its OWN triggers first.
function ddInstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'ddOnSheetEdit' || f === 'ddFlushBuild' || f === 'ddDailyBuild') {
      ScriptApp.deleteTrigger(t);
    }
  });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('ddOnSheetEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('ddFlushBuild').timeBased().everyMinutes(5).create();
  DD_DAILY_HOURS.forEach(function (h) {
    ScriptApp.newTrigger('ddDailyBuild').timeBased().atHour(h).everyDays(1).create();
  });
  ss.toast('Auto-rebuild installed. Edits rebuild about ' + DD_QUIET_MINUTES
           + ' minutes after you stop, plus scheduled builds at '
           + DD_DAILY_HOURS.join(':00, ') + ':00 for the automatic refreshes.',
           "Donny's Digital", 8);
}

function ddRemoveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'ddOnSheetEdit' || f === 'ddFlushBuild' || f === 'ddDailyBuild') {
      ScriptApp.deleteTrigger(t);
    }
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
  var fns = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction();
  });
  var installed = fns.indexOf('ddFlushBuild') !== -1;
  var daily = 0;
  for (var i = 0; i < fns.length; i++) if (fns[i] === 'ddDailyBuild') daily++;
  SpreadsheetApp.getUi().alert(
    "Donny's Digital -- auto-rebuild" + '\n\n'
    + 'Timer installed: ' + (installed ? 'yes' : 'NO -- run ddInstallTriggers') + '\n'
    + 'Scheduled:       ' + (daily === DD_DAILY_HOURS.length
                               ? daily + ' a day, at ' + DD_DAILY_HOURS.join(':00, ') + ':00'
                               : daily + ' of ' + DD_DAILY_HOURS.length
                                 + ' installed -- run ddInstallTriggers') + '\n'
    + 'Pending changes: ' + (p.getProperty(DD_P_DIRTY) === '1' ? 'yes' : 'no') + '\n'
    + 'Last edit seen:  ' + fmt(p.getProperty(DD_P_LASTEDIT)) + '\n'
    + 'Last build sent: ' + fmt(p.getProperty(DD_P_LASTBUILD)) + '\n\n'
    + 'Builds fire once the sheet has been quiet for ' + DD_QUIET_MINUTES
    + ' minutes, and at ' + DD_DAILY_HOURS.join(':00, ') + ':00 regardless.\n\n'
    + 'The scheduled ones are the only thing that catches the automatic\n'
    + 'refreshes: onEdit does not fire for a change a script or an import\n'
    + 'makes, only for a person typing in a cell.');
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
