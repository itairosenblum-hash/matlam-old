// =====================================================
// מערכת תורנויות - BACKEND (Google Apps Script)
// =====================================================
// הוראות התקנה:
// 1. בגיליון שלך: תוספות > Apps Script
// 2. מחק הכל, הדבק קוד זה
// 3. לחץ: פריסה > פריסה חדשה > אפליקציית אינטרנט
// 4. הגדר: "בצע כ: אני", "גישה: כולם"
// 5. העתק את ה-URL והכנס לאתר בהגדרות
// =====================================================

const SH = {
  USERS: 'Users',
  PEOPLE: 'People',
  DUTY_TYPES: 'DutyTypes',
  SCORES: 'Scores',
  SESSIONS: 'Sessions'
};

const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTH_NAMES = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

// ===== ENTRY POINTS =====
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    return makeResp(route(data));
  } catch(err) {
    return makeResp({success: false, error: err.toString()});
  }
}

function doGet(e) {
  try {
    const params = {};
    const callback = e && e.parameter && e.parameter.callback;
    if (e && e.parameter) {
      Object.keys(e.parameter).forEach(k => {
        if (k === 'callback') return;
        const v = e.parameter[k];
        // Keep pure 6-digit numbers as strings (month codes like 202507)
        if (/^\d{6}$/.test(v)) { params[k] = v; return; }
        try { params[k] = JSON.parse(v); }
        catch(_) { params[k] = v; }
      });
    }
    const result = route(params);
    const json = JSON.stringify(result);
    if (callback) {
      // JSONP response - bypasses CORS completely
      return ContentService
        .createTextOutput(callback + '(' + json + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return makeResp(result);
  } catch(err) {
    const errJson = JSON.stringify({success: false, error: err.toString()});
    const callback2 = e && e.parameter && e.parameter.callback;
    if (callback2) {
      return ContentService
        .createTextOutput(callback2 + '(' + errJson + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return makeResp({success: false, error: err.toString()});
  }
}

function makeResp(data) {
  const out = ContentService.createTextOutput(JSON.stringify(data));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}

function doOptions(e) {
  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}

// ===== ROUTER =====
function route(req) {
  const action = req.action;
  if (action === 'ping') return {success: true, message: 'מערכת תורנויות v1.0'};
  if (action === 'login') return actionLogin(req);
  if (action === 'bootstrap') return actionBootstrap();
  if (action === 'getLockStatus') return actionGetLockStatus(req);

  const user = validateToken(req.token);
  if (!user) return {success: false, error: 'אין הרשאה', code: 401};

  // Viewer (צופה) accounts are strictly read-only: schedule, scores, tornim,
  // notifications + changing their own password. Everything else is blocked.
  if (user.role === 'viewer') {
    var viewerAllowed = ['getSchedule','getScores','getAllTornim','getPeople','getProfile',
                         'getDutyTypes','getNotifications','clearNotification','clearAllNotifications','changePassword'];
    if (viewerAllowed.indexOf(action) === -1) {
      return {success:false, error:'לחשבון צפייה אין הרשאה לפעולה זו'};
    }
  }

  // User actions
  if (action === 'getProfile') return {success: true, user};
  if (action === 'getConstraints') return actionGetConstraints(req, user);
  if (action === 'saveConstraints') return withAudit(user, 'הגשת אילוצים', String(req.month||'') + (req.viewAs ? ' עבור ' + req.viewAs : '') + (Array.isArray(req.constraints) ? ' | X: ' + req.constraints.filter(function(c){return c==='X';}).length + ' | V: ' + req.constraints.filter(function(c){return c==='V';}).length : ''), actionSaveConstraints(req, user));
  if (action === 'getSchedule') return actionGetSchedule(req, user);
  if (action === 'changePassword') return withAudit(user, 'שינוי סיסמה', String(user.username||''), actionChangePassword(req, user));

  // Available to all authenticated users
  if (action === 'getPeople') return actionGetPeople();
  if (action === 'submitSwap') return withAudit(user, 'בקשת החלפה', String(req.date||'') + ' ⇄ ' + String(req.withWho||'') + (req.note ? ' | הערה: ' + req.note : ''), actionSubmitSwap(req, user));
  if (action === 'getSwaps') return actionGetSwaps(req, user);
  if (action === 'getScores') return actionGetScores(req); // all users can see scores
  if (action === 'getToraniHistory') return actionGetToraniHistory(req, user);
  if (action === 'getNotifications') return actionGetNotificationsPersonal(req, user);
  if (action === 'clearNotification') return actionClearNotification(req, user);
  if (action === 'clearAllNotifications') return actionClearAllNotifications(req, user);
  if (action === 'updateSwap') return withAudit(user, 'עדכון החלפה: ' + String(req.status||''), 'בקשה ' + String(req.id||''), actionUpdateSwap(req, user));
  if (action === 'deleteSwap' && user.role === 'admin') return withAudit(user, 'מחיקת בקשת החלפה', String(req.id||''), actionDeleteSwap(req));

  // updateTorani: admins may edit anyone with any field (handled below, past the
  // admin gate). Regular users may reach it too, but ONLY on their own record and
  // ONLY for self-service fields — role/activity/dutyCategory/active/newPassword
  // are silently dropped even if present in the request, so a tampered client
  // payload can never use this action to escalate privileges or reactivate/
  // deactivate/recategorize the account. Status and category stay admin-only,
  // matching the note already shown in the profile UI.
  if (action === 'updateTorani' && user.role !== 'admin') {
    if (String(req.username || '') !== String(user.username || '')) {
      return {success: false, error: 'ניתן לערוך רק את הפרטים שלך'};
    }
    var selfReq = {
      username: user.username,
      phone: req.phone,
      email: req.email,
      endDate: req.endDate,
      weekendType: req.weekendType,
      isMilitaryVehicle: req.isMilitaryVehicle,
      vehicleCompany: req.vehicleCompany,
      vehicleModel: req.vehicleModel,
      vehicleColor: req.vehicleColor,
      vehiclePlate: req.vehiclePlate
    };
    return withAudit(user, 'עדכון פרופיל עצמי', String(user.username||'') + (auditFields({'טלפון':selfReq.phone, 'אימייל':selfReq.email, 'סיום שירות':selfReq.endDate, 'סופ"ש':selfReq.weekendType, 'רכב צבאי':selfReq.isMilitaryVehicle, 'לוחית זיהוי':selfReq.isMilitaryVehicle==='כן'?selfReq.vehiclePlate:undefined}) ? ' | ' + auditFields({'טלפון':selfReq.phone, 'אימייל':selfReq.email, 'סיום שירות':selfReq.endDate, 'סופ"ש':selfReq.weekendType, 'רכב צבאי':selfReq.isMilitaryVehicle, 'לוחית זיהוי':selfReq.isMilitaryVehicle==='כן'?selfReq.vehiclePlate:undefined}) : ''), actionUpdateTorani(selfReq));
  }

  // Admin only
  if (user.role !== 'admin') return {success: false, error: 'אין הרשאת מנהל', code: 403};
  if (action === 'getUsers') return actionGetUsers();
  if (action === 'getAuditLog') return actionGetAuditLog(req);
  if (action === 'getAdminDashboard') return actionGetAdminDashboard(req, user);
  if (action === 'addUser') return withAudit(user, 'הוספת משתמש', String(req.username||'') + ' | ' + auditFields({'שם':req.name, 'תפקיד':req.role||'user'}), actionAddUser(req));
  if (action === 'updateUser') return withAudit(user, 'עדכון משתמש', String(req.username||'') + (auditFields({'שם חדש':req.name, 'תפקיד':req.role, 'סיסמה':req.newPassword?'שונתה':''}) ? ' | ' + auditFields({'שם חדש':req.name, 'תפקיד':req.role, 'סיסמה':req.newPassword?'שונתה':''}) : ''), actionUpdateUser(req));
  if (action === 'toggleUser') return withAudit(user, 'הפעלה/השבתה של משתמש', String(req.username||''), actionToggleUser(req));
  if (action === 'getAllConstraints') return actionGetAllConstraints(req);
  if (action === 'generateSchedule') return withAudit(user, 'הפקת שיבוץ', String(req.month||'') + (req.dayCategories && auditDayCatCount(req.dayCategories) ? ' | ' + auditDayCatCount(req.dayCategories) : ''), actionGenerateScheduleV2(req));  // uses duty_agent logic
  if (action === 'generateScheduleLegacy') return withAudit(user, 'הפקת שיבוץ (ישן)', String(req.month||''), actionGenerateSchedule(req));
  if (action === 'initMonth') return withAudit(user, 'יצירת לוח חודש', String(req.month||'') || (String(req.year||'')+'-'+String(req.mon||'')), actionInitMonth(req));
  if (action === 'resetSchedule') return withAudit(user, 'איפוס לוח', String(req.month||''), actionResetSchedule(req));
  if (action === 'setLockStatus') return withAudit(user, 'סטטוס הגשת אילוצים', String(req.month||'') + ' → ' + String(req.locked), actionSetLockStatus(req));
  if (action === 'updatePerson') return withAudit(user, 'עדכון פרטי תורן', String(req.name||'') + (auditFields({'פעילות':req.activity, 'קטגוריה':req.dutyCategory, 'סופ"ש':req.weekendType}) ? ' | ' + auditFields({'פעילות':req.activity, 'קטגוריה':req.dutyCategory, 'סופ"ש':req.weekendType}) : ''), actionUpdatePerson(req));
  if (action === 'sendReminder') return withAudit(user, 'שליחת תזכורת אילוצים', String(req.month||''), actionSendReminder(req));
  if (action === 'sendScheduleEmails') return withAudit(user, 'שליחת לוח במייל', String(req.month||''), actionSendScheduleEmails(req));

  if (action === 'reApplySwap') return withAudit(user, 'ביצוע חוזר של החלפה', String(req.id||''), actionReApplySwap(req));
  if (action === 'fixV2Score') return withAudit(user, 'תיקון ניקוד', String(req.month||'') + ' ' + String(req.name||'') + (auditFields({'ניקוד':req.score!==undefined?('+'+req.score):undefined, 'סוג':req.dutyType}) ? ' | ' + auditFields({'ניקוד':req.score!==undefined?('+'+req.score):undefined, 'סוג':req.dutyType}) : ''), actionFixV2Score(req));
  if (action === 'adjustScore') return withAudit(user, (Number(req.score) > 0 ? '➕ תגמול ניקוד' : '➖ קנס ניקוד'), String(req.personName||'') + ' | ' + auditFields({'ניקוד': req.score!==undefined?((Number(req.score)>0?'+':'')+req.score):undefined, 'סיבה': req.reason}), actionAdjustScore(req));
  if (action === 'sendSchedule') return actionSendSchedule(req);
  if (action === 'sendAdminMessage') return actionSendAdminMessage(req);
  if (action === 'debugSwap') return actionDebugSwap(req);
  if (action === 'resetPassword' && user.role === 'admin') return withAudit(user, 'איפוס סיסמה', String(req.username||''), actionResetPassword(req));
  if (action === 'getAllTornim') return actionGetAllTornim();
  if (action === 'addTorani') return withAudit(user, 'הוספת תורן', String(req.name||'') + ' | ' + auditFields({'תפקיד':req.role||'user', 'פעילות':req.activity, 'קטגוריה':req.dutyCategory, 'סופ"ש':req.weekendType, 'סיום שירות':req.endDate, 'רכב צבאי':req.isMilitaryVehicle, 'לוחית זיהוי':req.isMilitaryVehicle==='כן'?req.vehiclePlate:undefined}), actionAddTorani(req));
  if (action === 'updateTorani') return withAudit(user, 'עריכת תורן', String(req.username||'') + (auditFields({'שם חדש':req.name, 'תפקיד':req.role, 'פעילות':req.activity, 'קטגוריה':req.dutyCategory, 'סופ"ש':req.weekendType, 'טלפון':req.phone, 'אימייל':req.email, 'סיום שירות':req.endDate, 'פעיל':req.active!==undefined?(req.active?'כן':'לא'):undefined, 'סיסמה':req.newPassword?'שונתה':undefined, 'רכב צבאי':req.isMilitaryVehicle, 'לוחית זיהוי':req.isMilitaryVehicle==='כן'?req.vehiclePlate:undefined}) ? ' | ' + auditFields({'שם חדש':req.name, 'תפקיד':req.role, 'פעילות':req.activity, 'קטגוריה':req.dutyCategory, 'סופ"ש':req.weekendType, 'טלפון':req.phone, 'אימייל':req.email, 'סיום שירות':req.endDate, 'פעיל':req.active!==undefined?(req.active?'כן':'לא'):undefined, 'סיסמה':req.newPassword?'שונתה':undefined, 'רכב צבאי':req.isMilitaryVehicle, 'לוחית זיהוי':req.isMilitaryVehicle==='כן'?req.vehiclePlate:undefined}) : ''), actionUpdateTorani(req));
  if (action === 'toggleTorani') return withAudit(user, 'הפעלה/השבתה של תורן', String(req.username||''), actionToggleTorani(req));
  if (action === 'deleteTorani') return withAudit(user, 'מחיקת תורן', String(req.username||''), actionDeleteTorani(req));
  if (action === 'updateScheduleEntry') return withAudit(user, 'עריכת לוח ידנית', String(req.month||'') + ' ' + String(req.date||'') + (auditFields({'מבצע':req.v!==undefined?(req.v||'-'):undefined, 'עתודה א':req.a!==undefined?(req.a||'-'):undefined, 'עתודה ב':req.b!==undefined?(req.b||'-'):undefined, 'סוג תורנות':req.dutyType, 'חניך':req.trainee!==undefined?(req.trainee||'-'):undefined, 'הערה':req.notes}) ? ' | ' + auditFields({'מבצע':req.v!==undefined?(req.v||'-'):undefined, 'עתודה א':req.a!==undefined?(req.a||'-'):undefined, 'עתודה ב':req.b!==undefined?(req.b||'-'):undefined, 'סוג תורנות':req.dutyType, 'חניך':req.trainee!==undefined?(req.trainee||'-'):undefined, 'הערה':req.notes}) : ''), actionUpdateScheduleEntry(req));
  if (action === 'initSheets') return withAudit(user, 'אתחול גיליונות', '', actionInitSheets());
  if (action === 'publishSchedule') return withAudit(user, 'סטטוס לוח: ' + (req.status === 'draft' ? 'טיוטה' : 'פורסם'), String(req.month||''), actionPublishSchedule(req, user));

  return {success: false, error: 'פעולה לא מוכרת: ' + action};
}

// ===== UTILS =====
function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function hashPass(pw) {
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw, Utilities.Charset.UTF_8);
  return b.map(x => ('0' + (x & 0xFF).toString(16)).slice(-2)).join('');
}

function fmtDate(d) {
  if (!d) return '';
  if (d instanceof Date) return Utilities.formatDate(d, 'Asia/Jerusalem', 'yyyy-MM-dd');
  return String(d).substring(0, 10);
}

// ===== AUTH =====
function actionLogin(req) {
  const {username, password} = req;
  if (!username || !password) return {success: false, error: 'חסרים פרטי כניסה'};

  const sheet = getSheet(SH.USERS);
  const rows = sheet.getDataRange().getValues();
  const hash = hashPass(password);

  for (let i = 1; i < rows.length; i++) {
    const [, name, uname, pwd, role, active] = rows[i];
    if (String(uname).toLowerCase() === String(username).toLowerCase() && pwd === hash) {
      if (!active) return {success: false, error: 'החשבון מושבת'};
      const token = Utilities.getUuid();
      // Session length: admins 24h, everyone else 30 days
      const sessionDays = (role === 'admin') ? 1 : 30;
      const expiry = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
      getSheet(SH.SESSIONS).appendRow([token, username, name, role, new Date().toISOString(), expiry.toISOString()]);
      if (Math.random() < 0.1) cleanSessions();
      return {success: true, token, name, username, role, expiry: expiry.toISOString()};
    }
  }
  return {success: false, error: 'שם משתמש או סיסמה שגויים'};
}

function validateToken(token) {
  if (!token) return null;
  const rows = getSheet(SH.SESSIONS).getDataRange().getValues();
  const now = new Date();
  for (let i = 1; i < rows.length; i++) {
    const [tok, username, name, role, , expiry] = rows[i];
    if (tok === token && new Date(expiry) > now) return {username, name, role};
  }
  return null;
}

function cleanSessions() {
  const sheet = getSheet(SH.SESSIONS);
  const rows = sheet.getDataRange().getValues();
  const now = new Date();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (new Date(rows[i][5]) < now) sheet.deleteRow(i + 1);
  }
}

// ===== AUDIT LOG =====
// Builds a compact "key: value | key: value" string from an object,
// skipping any field that's undefined/null/empty — used to enrich audit details
// with the actual data the request carried, without needing extra sheet reads.
function auditFields(obj) {
  var parts = [];
  Object.keys(obj).forEach(function(k) {
    var v = obj[k];
    if (v === undefined || v === null || v === '') return;
    parts.push(k + ': ' + v);
  });
  return parts.join(' | ');
}

function auditDayCatCount(dayCategories) {
  try {
    var obj = (typeof dayCategories === 'string') ? JSON.parse(dayCategories) : dayCategories;
    var n = obj ? Object.keys(obj).length : 0;
    return n > 0 ? (n + ' ימים הוגדרו ידנית') : '';
  } catch(e) { return ''; }
}

function withAudit(user, label, details, result) {
  try {
    if (result && result.success) logAudit(user, label, details);
  } catch(e) { Logger.log('withAudit error: ' + e); }
  return result;
}

function logAudit(user, action, details) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName('AuditLog');
    if (!sh) {
      sh = ss.insertSheet('AuditLog');
      sh.setRightToLeft(true);
      sh.getRange(1,1,1,4).setValues([['תאריך','משתמש','פעולה','פרטים']]);
    }
    const who = (user && (user.name || user.username)) ? String(user.name || user.username) : String(user || '');
    sh.appendRow([new Date().toISOString(), who, String(action || ''), String(details || '')]);
    if (Math.random() < 0.02) cleanAuditLog(sh);
  } catch(e) { Logger.log('logAudit error: ' + e); }
}

function cleanAuditLog(sh) {
  try {
    sh = sh || SpreadsheetApp.getActiveSpreadsheet().getSheetByName('AuditLog');
    if (!sh) return;
    const cutoff = new Date(Date.now() - 183 * 24 * 60 * 60 * 1000); // ~6 months
    const rows = sh.getDataRange().getValues();
    for (let i = rows.length - 1; i >= 1; i--) {
      const d = new Date(rows[i][0]);
      if (d && !isNaN(d) && d < cutoff) sh.deleteRow(i + 1);
    }
  } catch(e) { Logger.log('cleanAuditLog error: ' + e); }
}

function actionChangePassword(req, user) {
  const {oldPassword, newPassword} = req;
  if (!oldPassword || !newPassword) return {success: false, error: 'חסרים שדות'};
  const sheet = getSheet(SH.USERS);
  const rows = sheet.getDataRange().getValues();
  const oldHash = hashPass(oldPassword);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] === user.username && rows[i][3] === oldHash) {
      sheet.getRange(i + 1, 4).setValue(hashPass(newPassword));
      return {success: true};
    }
  }
  return {success: false, error: 'הסיסמה הנוכחית שגויה'};
}

// ===== USERS =====
function actionGetUsers() {
  const rows = getSheet(SH.USERS).getDataRange().getValues();
  const users = [];
  for (let i = 1; i < rows.length; i++) {
    const [id, name, username, , role, active] = rows[i];
    if (username) users.push({id, name, username, role, active: !!active});
  }
  return {success: true, users};
}

function actionAddUser(req) {
  const {name, username, password, role} = req;
  if (!name || !username || !password) return {success: false, error: 'חסרים שדות חובה'};
  const sheet = getSheet(SH.USERS);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][2]).toLowerCase() === String(username).toLowerCase())
      return {success: false, error: 'שם המשתמש כבר קיים'};
  }
  sheet.appendRow([Utilities.getUuid().substring(0, 8), name, username, hashPass(password), role || 'user', true]);
  return {success: true};
}

function actionUpdateUser(req) {
  const {username, name, role, newPassword} = req;
  const sheet = getSheet(SH.USERS);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] === username) {
      if (name) sheet.getRange(i + 1, 2).setValue(name);
      if (role) sheet.getRange(i + 1, 5).setValue(role);
      if (newPassword) sheet.getRange(i + 1, 4).setValue(hashPass(newPassword));
      return {success: true};
    }
  }
  return {success: false, error: 'משתמש לא נמצא'};
}

function actionToggleUser(req) {
  const sheet = getSheet(SH.USERS);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] === req.username) {
      const current = !!rows[i][5];
      sheet.getRange(i + 1, 6).setValue(!current);
      return {success: true, active: !current};
    }
  }
  return {success: false, error: 'משתמש לא נמצא'};
}

// ===== PEOPLE =====
function actionGetPeople() {
  const rows = getSheet(SH.PEOPLE).getDataRange().getValues();
  const people = [];
  for (let i = 1; i < rows.length; i++) {
    const [name, activity, dutyCategory, phone, weekendType, email, endDate,
      isMilitaryVehicle, vehicleCompany, vehicleModel, vehicleColor, vehiclePlate] = rows[i];
    if (name) people.push({
      name: String(name),
      activity: String(activity),
      dutyCategory: String(dutyCategory || ''),
      phone: String(phone || ''),
      weekendType: String(weekendType || 'מלא'),
      email: String(email || ''),
      endDate: endDate ? (endDate instanceof Date ? Utilities.formatDate(endDate, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(endDate).split('T')[0]) : '',
      isMilitaryVehicle: String(isMilitaryVehicle || '') === 'כן' ? 'כן' : 'לא',
      vehicleCompany: String(vehicleCompany || ''),
      vehicleModel: String(vehicleModel || ''),
      vehicleColor: String(vehicleColor || ''),
      vehiclePlate: String(vehiclePlate || '')
    });
  }
  return {success: true, people};
}

// A vehicle's company/model/color/plate are only meaningful when the torani
// actually has a military vehicle — if not, the sub-fields are cleared server-side
// too (not just hidden in the UI), so stale data never lingers after the toggle
// is switched off.
function normalizeVehicleFields(req) {
  const isMilitary = String(req.isMilitaryVehicle || '') === 'כן';
  return {
    isMilitaryVehicle: isMilitary ? 'כן' : 'לא',
    vehicleCompany: isMilitary ? String(req.vehicleCompany || '').trim() : '',
    vehicleModel: isMilitary ? String(req.vehicleModel || '').trim() : '',
    vehicleColor: isMilitary ? String(req.vehicleColor || '').trim() : '',
    vehiclePlate: isMilitary ? String(req.vehiclePlate || '').trim() : ''
  };
}

function actionUpdatePerson(req) {
  const {name, weekendType, dutyCategory, activity} = req;
  if (!name) return {success: false, error: 'חסר שם'};
  const sheet = getSheet(SH.PEOPLE);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === name) {
      if (activity !== undefined) sheet.getRange(i+1, 2).setValue(activity);
      if (dutyCategory !== undefined) sheet.getRange(i+1, 3).setValue(dutyCategory);
      if (weekendType !== undefined) sheet.getRange(i+1, 5).setValue(weekendType);
      return {success: true};
    }
  }
  return {success: false, error: 'תורן לא נמצא'};
}

// ===== SCORES: PER-YEAR SHEETS =====
// The scores sheet holds ONE year of monthly detail (cols E-AB = 12 x [type,score]),
// a carry-in total (col C) and the running total (col D). Column positions are
// derived from the MONTH NUMBER alone, so a single shared sheet cannot hold two
// years at once — generating Jan 2027 would overwrite Jan 2026's cells.
// Solution: one sheet per year, `Scores_YYYY`, chosen from the month being written.
// Dec 2026 edits and Jan 2027 generation then land in different sheets and never
// collide, so there is no rollover moment and no danger window.

var SCORES_HEADERS = ['שם','פעילות','מצטבר קודם','מצטבר שנתי',
  'ינואר סוג','ינואר ניקוד','פברואר סוג','פברואר ניקוד',
  'מרץ סוג','מרץ ניקוד','אפריל סוג','אפריל ניקוד',
  'מאי סוג','מאי ניקוד','יוני סוג','יוני ניקוד',
  'יולי סוג','יולי ניקוד','אוגוסט סוג','אוגוסט ניקוד',
  'ספטמבר סוג','ספטמבר ניקוד','אוקטובר סוג','אוקטובר ניקוד',
  'נובמבר סוג','נובמבר ניקוד','דצמבר סוג','דצמבר ניקוד'];

// Year for a YYYYMM month code, or the current calendar year when absent.
function scoreYearOf(month) {
  var m = String(month || '').trim();
  if (/^\d{6}$/.test(m)) return m.substring(0, 4);
  return String(new Date().getFullYear());
}

// Returns the Scores sheet for `year`.
// Order of resolution:
//   1. Scores_<year> if it exists
//   2. the legacy single `Scores` sheet — so nothing breaks before migration
//   3. create Scores_<year>, seeding col C from the previous year's final totals
function getScoresSheet(year) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var y  = String(year || new Date().getFullYear());
  var sh = ss.getSheetByName('Scores_' + y);
  if (sh) return sh;

  // Pre-migration: a lone `Scores` sheet still serves whichever year it holds.
  var legacy = ss.getSheetByName(SH.SCORES);
  if (legacy) {
    var legacyYear = legacyScoresYear(legacy);
    if (!legacyYear || legacyYear === y) return legacy;
  }
  return createScoresSheetForYear(y);
}

// Reads the year the legacy `Scores` sheet tracks from its col-D header
// ("מצטבר 2026"). Returns null if the header carries no year.
function legacyScoresYear(sh) {
  try {
    var m = String(sh.getRange(1, 4).getValue() || '').match(/(\d{4})/);
    return m ? m[1] : null;
  } catch(e) { return null; }
}

// Builds Scores_<year> from scratch: same people, monthly columns empty, and
// col C carrying the previous year's final total (its col C + its 12 monthly
// scores) so accumulated fairness survives the year boundary.
function createScoresSheetForYear(year) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var y  = String(year);
  var sh = ss.insertSheet('Scores_' + y);
  sh.setRightToLeft(true);

  var hdrs = SCORES_HEADERS.slice();
  hdrs[2] = 'מצטבר ' + (parseInt(y, 10) - 1);
  hdrs[3] = 'מצטבר ' + y;
  sh.getRange(1, 1, 1, hdrs.length).setValues([hdrs]);

  var prev = ss.getSheetByName('Scores_' + (parseInt(y, 10) - 1));
  if (!prev) {
    var lg = ss.getSheetByName(SH.SCORES);
    if (lg && legacyScoresYear(lg) === String(parseInt(y, 10) - 1)) prev = lg;
  }

  var out = [];
  if (prev && prev.getLastRow() > 1) {
    var prevRows = prev.getDataRange().getValues();
    for (var i = 1; i < prevRows.length; i++) {
      var nm = String(prevRows[i][0] || '').trim();
      if (!nm) continue;
      var carry = Number(prevRows[i][2]) || 0;           // previous carry-in
      for (var mI = 0; mI < 12; mI++) carry += Number(prevRows[i][5 + mI * 2]) || 0;
      var row = new Array(hdrs.length).fill('');
      row[0] = nm;
      row[1] = String(prevRows[i][1] || '1');
      row[2] = Math.round(carry);
      row[3] = Math.round(carry);   // running total starts at the carry-in
      out.push(row);
    }
  }
  if (out.length) sh.getRange(2, 1, out.length, hdrs.length).setValues(out);
  Logger.log('Created Scores_' + y + ' with ' + out.length + ' people');
  return sh;
}

// The scores sheet holds ONE year of monthly detail. Every write indexes its
// columns by month number alone (4 + (mon-1)*2), with no year component — so
// generating January 2027 would write over January 2026 and destroy it silently.
// Schedule_2027MM sheets already exist (initAllSchedules built 2026-2029), so
// nothing but this guard stands between a mis-click and lost history.
// The year is read from the col-D header ("מצטבר 2026") rather than hardcoded,
// so it follows automatically whenever the sheet is rolled over to a new year.
function getActiveScoreYear() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var lg = ss.getSheetByName(SH.SCORES);
    if (lg) { var ly = legacyScoresYear(lg); if (ly) return ly; }
  } catch(e) { Logger.log('getActiveScoreYear: ' + e); }
  return String(new Date().getFullYear());
}

// Returns an error object if `month` (YYYYMM) belongs to a different year than
// the Scores sheet currently tracks; returns null when the write is safe.
// Cross-year writes were dangerous only while every year shared one sheet.
// With Scores_YYYY they land in separate sheets, so the block is lifted — but
// only once the target year actually has (or can get) its own sheet. Before
// migration the legacy single sheet is still in play, and the old danger stands.
function guardScoreYear(month) {
  var reqYear = String(month || '').substring(0, 4);
  if (!reqYear) return null;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Scores_' + reqYear)) return null;   // year has its own sheet
  var legacy = ss.getSheetByName(SH.SCORES);
  if (!legacy) return null;                                  // fully migrated
  var legacyYear = legacyScoresYear(legacy);
  if (!legacyYear || legacyYear === reqYear) return null;
  return {success: false, error:
    'חסום: גיליון הניקוד עדיין מנהל את שנת ' + legacyYear + ' בגיליון יחיד, והבקשה היא לשנת ' + reqYear + '. ' +
    'יש לשנות את שם הגיליון "Scores" ל-"Scores_' + legacyYear + '" כדי לעבור למבנה רב-שנתי, ואז הפעולה תתאפשר.'};
}

function actionGetScores(req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  // Single source of truth for the year this function reports on — used both by
  // the sheet filter and by the month-code lookup below, so they can never drift.
  // Which year to report on: an explicit ?year=, else whatever the system
  // currently tracks. Everything below — sheet choice, schedule filter and month
  // codes — derives from this one value, so they can never drift apart.
  const SCORE_YEAR = (req && /^\d{4}$/.test(String(req.year || ''))) ? String(req.year)
                                                                     : getActiveScoreYear();

  // Get all people
  const peopleRes = actionGetPeople();
  const people = peopleRes.people;

  // The Users sheet is the authority on account state: the "פעיל" flag and the
  // role. People's activity column is a separate field and is NOT kept in sync
  // with it, so a torani deactivated on the tornim page still reads activity=1
  // here. Both must be consulted, exactly as actionGenerateScheduleV2 does.
  const usersActiveByName = {}, usersRoleByName = {};
  try {
    const uRows = getSheet(SH.USERS).getDataRange().getValues();
    for (let ui = 1; ui < uRows.length; ui++) {
      const un = String(uRows[ui][1] || '').trim();
      if (!un) continue;
      usersActiveByName[un] = !!uRows[ui][5];
      usersRoleByName[un]   = String(uRows[ui][4] || '').trim();
    }
  } catch (e) { Logger.log('actionGetScores: Users load failed — ' + e); }

  // Base scores from Score sheet (2025 accumulation)
  const baseScores = {};
  const scoreRowByName = {};   // name -> full Scores row (monthly type/score columns)
  const scoreSheet = getScoresSheet(SCORE_YEAR);
  const scoreRows = scoreSheet.getDataRange().getValues();
  for (let i = 1; i < scoreRows.length; i++) {
    if (!scoreRows[i][0]) continue;
    const sName = String(scoreRows[i][0]).trim();
    scoreRowByName[sName] = scoreRows[i];
    baseScores[sName] = {
      acc2025: Number(scoreRows[i][2]) || 0,
      activity: String(scoreRows[i][1] || '1')
    };
  }

  // Only the ACTIVE scoring year's schedules.
  // initAllSchedules() created 2026-2029, so the sheet holds 48 Schedule_ tabs —
  // 36 of them empty future months. The result below is built purely from
  // SCORE_YEAR, so every other year was fetched, parsed, and thrown away.
  // Measured (diagScores): reading all 48 = 13,197ms out of a 14,402ms total — 92%.
  const yearRe = new RegExp('^Schedule_' + SCORE_YEAR + '\\d{2}$');
  const scheduleSheets = sheets.filter(s => yearRe.test(s.getName()));

  // Compute scores per person per month from actual schedules
  const personMonthScores = {}; // name -> { '202601': {score, type}, ... }

  scheduleSheets.forEach(sheet => {
    const monthCode = sheet.getName().replace('Schedule_',''); // e.g. '202606'
    const year = monthCode.substring(0,4);
    const mon = parseInt(monthCode.substring(4,6));
    const rows = sheet.getDataRange().getValues();

    // Headers: תאריך, יום, סוג יום, מבצע, עתודה א, עתודה ב, הערות, סוג תורנות, ניקוד, מבצע שני, עתודה א שנייה, עתודה ב שנייה
    for (let i = 1; i < rows.length; i++) {
      const vName  = String(rows[i][3] || '').trim();
      const v2Name = String(rows[i][9] || '').trim();
      const dutyType = String(rows[i][7] || rows[i][2] || '');
      const sc = Number(rows[i][8]) || 0;

      // Add score for V (main)
      if (vName && sc > 0) {
        if (!personMonthScores[vName]) personMonthScores[vName] = {};
        if (!personMonthScores[vName][monthCode])
          personMonthScores[vName][monthCode] = {score: 0, type: dutyType};
        personMonthScores[vName][monthCode].score += sc;
        personMonthScores[vName][monthCode].type = dutyType;
      }

      // Add score for V2 (second shift) - same score as main duty
      if (v2Name && sc > 0) {
        if (!personMonthScores[v2Name]) personMonthScores[v2Name] = {};
        if (!personMonthScores[v2Name][monthCode])
          personMonthScores[v2Name][monthCode] = {score: 0, type: dutyType};
        personMonthScores[v2Name][monthCode].score += sc;
      }
    }
  });

  // Build result.
  // The scores page ranks people competing for the same duties, so anyone who
  // is not in the rotation is noise: their frozen total sits in the table and
  // distorts every comparison. Excluded: admin, משרת אב, unqualified tornim,
  // deactivated accounts, and viewer (read-only) accounts.
  // Note p.role does not exist — actionGetPeople reads the People sheet, which
  // has no role column, so the old `p.role === 'admin'` check never fired.
  const SCORES_HIDDEN_CATEGORIES = ['אב', 'מנהל מערכת', 'לא מוסמך', 'טרם הוסמך'];
  const scores = people.filter(p => {
    const nm  = String(p.name || '').trim();
    const cat = String(p.dutyCategory || '').trim();
    if (nm === 'מנהל מערכת') return false;
    if (SCORES_HIDDEN_CATEGORIES.indexOf(cat) !== -1) return false;
    if (String(p.activity || '1').trim() === '0') return false;   // inactive in People
    if (usersActiveByName[nm] === false) return false;            // deactivated account
    if (usersRoleByName[nm] === 'admin') return false;
    if (usersRoleByName[nm] === 'viewer') return false;           // read-only account
    return true;
  }).map(p => {
    const base = baseScores[p.name] || {};
    const monthData = personMonthScores[p.name] || {};

    // Compute 2026 accumulated total from schedules
    let acc2026 = 0;
    const monthScores = {};
    const sRow = scoreRowByName[p.name];
    monthNames.forEach((mKey, idx) => {
      const mon = idx + 1;
      const code2026 = SCORE_YEAR + String(mon).padStart(2,'0');
      const md = monthData[code2026] || {score:0, type:''};

      let mType = md.type, mScore = md.score;

      // The schedule sheets only know about people who were ASSIGNED a duty.
      // Exemptions (פטור) and manual corrections are written straight into the
      // Scores sheet's monthly columns by actionGenerateScheduleV2 and by hand —
      // reading only the schedules silently drops them (a פטור month showed 0
      // instead of 10). So when the schedule yields nothing for a month, fall
      // back to the Scores sheet, which is the authority for those entries.
      // Scores layout: col E(4)=ינואר סוג, F(5)=ינואר ניקוד, G(6)=פברואר סוג ...
      if (!mScore && sRow) {
        const fbType  = String(sRow[4 + idx * 2] || '').trim();
        const fbScore = Number(sRow[5 + idx * 2]) || 0;
        if (fbType || fbScore) { mType = fbType; mScore = fbScore; }
      }

      monthScores[mKey] = {score: mScore, type: mType};
      acc2026 += mScore;
    });

    const result = {
      name: p.name,
      activity: p.activity,
      dutyCategory: p.dutyCategory || '',
      weekendType: p.weekendType || '',
      // carryIn / total are the year-neutral names. acc2025/acc2026 are kept as
      // aliases so the existing frontend keeps working unchanged during rollout.
      carryIn: base.acc2025 || 0,
      total:   Math.round(acc2026),
      acc2025: base.acc2025 || 0,
      acc2026: Math.round(acc2026)
    };
    monthNames.forEach(m => {
      result[m] = monthScores[m] || {score:0, type:''};
    });
    return result;
  });

  return {success: true, scores, year: SCORE_YEAR, prevYear: String(parseInt(SCORE_YEAR,10) - 1),
          years: listScoreYears()};
}

// Every year the system has data for — powers the year picker in the UI.
function listScoreYears() {
  var years = {};
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ss.getSheets().forEach(function(s) {
      var m = s.getName().match(/^Scores_(\d{4})$/);
      if (m) years[m[1]] = true;
    });
    var lg = ss.getSheetByName(SH.SCORES);
    if (lg) { var ly = legacyScoresYear(lg); if (ly) years[ly] = true; }
  } catch(e) { Logger.log('listScoreYears: ' + e); }
  var out = Object.keys(years).sort();
  return out.length ? out : [String(new Date().getFullYear())];
}

// updateScoreForMonth() was removed here: defined but never called anywhere, and
// with per-year sheets a dormant month-indexed writer is a trap waiting to fire.

// ===== DIAGNOSTIC: where do actionGetScores' seconds actually go? =====
// Run this from the Apps Script EDITOR (Logger output isn't kept for anonymous
// JSONP executions). It mirrors actionGetScores stage by stage and times each
// one, so we measure instead of guessing.
function diagScores() {
  var t = [], mark = function(label, t0) { t.push([label, Date.now() - t0]); };

  var tAll = Date.now();

  var t0 = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  mark('1. openSpreadsheet', t0);

  t0 = Date.now();
  var sheets = ss.getSheets();
  mark('2. getSheets() [' + sheets.length + ' tabs]', t0);

  t0 = Date.now();
  var people = actionGetPeople().people;
  mark('3. actionGetPeople [' + people.length + ' people]', t0);

  t0 = Date.now();
  var scoreRows = getScoresSheet(getActiveScoreYear()).getDataRange().getValues();
  mark('4. read Scores sheet [' + scoreRows.length + ' rows]', t0);

  var YR = getActiveScoreYear() || '2026';
  t0 = Date.now();
  var allSched = sheets.filter(function(s){ return /^Schedule_\d{6}$/.test(s.getName()); });
  var yrRe = new RegExp('^Schedule_' + YR + '\\d{2}$');
  var scheduleSheets = allSched.filter(function(s){ return yrRe.test(s.getName()); });
  mark('5. filter [' + allSched.length + ' total, ' + scheduleSheets.length + ' in ' + YR + ']', t0);

  // Per-sheet read cost — this is the loop actionGetScores runs
  var perSheet = [], tLoop = Date.now();
  scheduleSheets.forEach(function(sh) {
    var ts = Date.now();
    var rows = sh.getDataRange().getValues();
    perSheet.push([sh.getName(), rows.length, Date.now() - ts]);
  });
  mark('6. read ' + YR + ' Schedule sheets only', tLoop);

  Logger.log('===== diagScores =====');
  t.forEach(function(x){ Logger.log(x[0] + ': ' + x[1] + 'ms'); });
  Logger.log('TOTAL: ' + (Date.now() - tAll) + 'ms');
  Logger.log('--- per Schedule sheet (name, rows, ms) ---');
  perSheet.sort(function(a,b){ return b[2] - a[2]; });
  perSheet.forEach(function(x){ Logger.log(x[0] + '  ' + x[1] + ' rows  ' + x[2] + 'ms'); });
}

// ===== MIGRATION: single `Scores` sheet -> per-year `Scores_YYYY` =====
// Run ONCE from the Apps Script editor. Reads the year out of the col-D header
// ("מצטבר 2026"), renames the sheet to Scores_<year>, and relabels col C/D to the
// year-neutral wording. No cell values are touched — only the tab name and two
// header captions — so it is fully reversible by renaming the tab back.
function migrateScoresToPerYear() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var legacy = ss.getSheetByName(SH.SCORES);
  if (!legacy) { Logger.log('אין גיליון "Scores" — כנראה כבר בוצעה הגירה.'); return 'כבר מוגר'; }

  var year = legacyScoresYear(legacy);
  if (!year) { Logger.log('לא הצלחתי לזהות שנה מכותרת עמודה D.'); return 'שגיאה: שנה לא זוהתה'; }
  if (ss.getSheetByName('Scores_' + year)) {
    Logger.log('Scores_' + year + ' כבר קיים — עוצר כדי לא לדרוס.');
    return 'שגיאה: Scores_' + year + ' כבר קיים';
  }

  legacy.setName('Scores_' + year);
  legacy.getRange(1, 3).setValue('מצטבר ' + (parseInt(year, 10) - 1));
  legacy.getRange(1, 4).setValue('מצטבר ' + year);

  Logger.log('✅ הגיליון "Scores" שונה ל-"Scores_' + year + '" (' + (legacy.getLastRow() - 1) + ' שורות).');
  Logger.log('מעכשיו כל שנה מקבלת גיליון משלה. Scores_' + (parseInt(year,10)+1) + ' ייווצר אוטומטית בהפקה הראשונה שלה.');
  return 'הוגר ל-Scores_' + year;
}

// ===== CONSTRAINTS =====
function actionGetConstraints(req, user) {
  const month = String(req.month || '');
  // viewAs: admin can view another user's constraints
  const viewAs = req.viewAs;
  const lookupName = viewAs ? getNameByUsername(viewAs) : user.name;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Constraints_' + month);
  if (!sheet) return {success: true, constraints: new Array(31).fill(''), notes: ''};
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === lookupName) {
      return {
        success: true,
        constraints: rows[i].slice(1, 32).map(c => {
          if (c === 'V' || c === 'v') return 'V';
          if (c === 'X' || c === 'x' || c === true) return 'X';
          return '';
        }),
        notes: rows[i][32] || ''
      };
    }
  }
  return {success: true, constraints: new Array(31).fill(''), notes: ''};
}

function getNameByUsername(username) {
  const rows = getSheet(SH.USERS).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][2]) === String(username)) return String(rows[i][1]);
  }
  return username;
}

function actionSaveConstraints(req, user) {
  const month = String(req.month || '');
  const {constraints, notes} = req;
  // viewAs: save for the target user, not the logged-in admin
  const saveName = req.viewAs ? getNameByUsername(req.viewAs) : user.name;
  
  // Check lock status (admin can always save)
  if (user.role !== 'admin') {
    const lockRes = actionGetLockStatus({month});
    if (lockRes.locked) {
      return {success: false, error: 'הגשת אילוצים לחודש זה נעולה. פנה למנהל.'};
    }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Constraints_' + month);
  if (!sheet) sheet = createConstraintSheet(month, ss);
  const rows = sheet.getDataRange().getValues();
  const rowData = [saveName, ...constraints.map(c => {
    if (c === 'V' || c === 'v') return 'V';
    if (c === 'X' || c === 'x' || c === true) return 'X';
    return '';
  }), notes || ''];
  let found = false;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === saveName) {
      sheet.getRange(i + 1, 1, 1, rowData.length).setValues([rowData]);
      found = true;
      break;
    }
  }
  if (!found) sheet.appendRow(rowData);
  return {success: true};
}

function actionGetAllConstraints(req) {
  const month = String(req.month || '');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Constraints_' + month);
  if (!sheet) return {success: true, constraints: {}, month};
  const rows = sheet.getDataRange().getValues();
  const result = {};
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    result[rows[i][0]] = {
      constraints: rows[i].slice(1, 32).map(c => {
        if (c === 'V' || c === 'v') return 'V';
        if (c === 'X' || c === 'x' || c === true) return 'X';
        return '';
      }),
      notes: rows[i][32] || ''
    };
  }
  return {success: true, constraints: result, month};
}

function createConstraintSheet(month, ss) {
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.insertSheet('Constraints_' + month);
  sheet.setRightToLeft(true);
  const headers = ['שם'];
  for (let d = 1; d <= 31; d++) headers.push(d);
  headers.push('הערות');
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  const people = actionGetPeople().people.filter(p => p.activity !== '0');
  people.forEach((p, idx) => sheet.getRange(idx + 2, 1).setValue(p.name));
  return sheet;
}

// ===== SCHEDULE =====
function actionGetSchedule(req, user) {
  const month = String(req.month || '');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Schedule_' + month);
  if (!sheet) return {success: true, schedule: [], month};
  const rows = sheet.getDataRange().getValues();
  const schedule = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    schedule.push({
      date: fmtDate(rows[i][0]), day: rows[i][1], dayType: rows[i][2],
      v: rows[i][3] || '', a: rows[i][4] || '', b: rows[i][5] || '',
      notes: rows[i][6] || '', dutyType: rows[i][7] || '', score: rows[i][8] || 0,
      v2: rows[i][9] || '', a2: rows[i][10] || '', b2: rows[i][11] || '',
      t: rows[i][12] || ''  // 🎓 תורנות הסמכה — manual only, no score, no reserves
    });
  }
  const schedStatus = getScheduleStatus(month);
  if (schedStatus === 'draft' && (!user || user.role !== 'admin')) {
    // Month is still a draft — hide it from non-admin users
    return {success: true, schedule: [], month, draft: true};
  }
  // Admin-only: names of tornim whose pre-month score already sat at/above the group
  // average but got no duty this month — the persistent "🚫 מדולגים החודש" banner.
  const skippedNames = (user && user.role === 'admin') ? computeSkippedTornim(month) : [];
  return {success: true, schedule, month, draft: schedStatus === 'draft', skippedNames};
}

// Names of tornim who received no duty this month at all (no V/V2 main duty,
// and — since reserve slots are only drawn from people who already have a
// V/V2 duty this month — no reserve either): active, in-rotation tornim (same
// eligibility filter as calcAverageScore) with zero assignment this month,
// plus anyone with a verified full-month "X" constraint regardless of
// category. This is the persistent "🚫 מדולגים החודש" banner.
// Admin's own name is always excluded, independent of the People dutyCategory value.
function computeSkippedTornim(month) {
  try {
    var mon = parseInt(String(month).substring(4,6), 10);
    if (!mon) return [];
    var year = scoreYearOf(month);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var daysInMonth = new Date(year, mon, 0).getDate();

    var assigned = {};
    var schedSheet = ss.getSheetByName('Schedule_' + month);
    if (schedSheet) {
      var schedRows = schedSheet.getDataRange().getValues();
      for (var i = 1; i < schedRows.length; i++) {
        var v1 = String(schedRows[i][3]||'').trim();
        var v2 = String(schedRows[i][9]||'').trim();
        if (v1) assigned[v1] = true;
        if (v2) assigned[v2] = true;
      }
    }

    // Full-month "X" constraints (e.g. via the "🚫 לא מבצע החודש" button, or
    // manually marking every day) are a skip for a known, explicit reason —
    // flag them regardless of where their score sits vs. the group average.
    var fullConstraint = {};
    var consSheet = ss.getSheetByName('Constraints_' + month);
    if (consSheet) {
      var consRows = consSheet.getDataRange().getValues();
      for (var ci = 1; ci < consRows.length; ci++) {
        var cName = String(consRows[ci][0]||'').trim();
        if (!cName) continue;
        var dayVals = consRows[ci].slice(1, 1 + daysInMonth);
        var allX = dayVals.length === daysInMonth && dayVals.every(function(c){
          var cv = String(c||'').trim().toUpperCase();
          return cv === 'X' || c === true;
        });
        if (allX) fullConstraint[cName] = true;
      }
    }

    var peopleMap = {};
    (actionGetPeople().people||[]).forEach(function(p){ peopleMap[String(p.name||'').trim()] = p; });

    var usersActive = {}, usersRole = {}, adminName = '';
    var uRows = getSheet(SH.USERS).getDataRange().getValues();
    for (var ua = 1; ua < uRows.length; ua++) {
      var uan = String(uRows[ua][1]||'').trim();
      if (!uan) continue;
      usersActive[uan] = !!uRows[ua][5];
      usersRole[uan] = String(uRows[ua][4]||'').trim();
      if (usersRole[uan] === 'admin') adminName = uan;
    }

    var scoreRows = getScoresSheet(year).getDataRange().getValues();
    var skipped = [];

    for (var j = 1; j < scoreRows.length; j++) {
      var name = String(scoreRows[j][0]||'').trim();
      if (!name || name === adminName) continue;
      var p = peopleMap[name] || {};
      var activity = String(p.activity||'1').trim();
      if (activity === '0') continue;               // deactivated person — not in rotation at all
      if (usersActive[name] === false) continue;      // account disabled
      if (usersRole[name] === 'viewer') continue;
      if (assigned[name]) continue;                    // got a duty this month

      // A verified full-month block (e.g. "🚫 לא מבצע החודש") is a skip on its
      // own, regardless of duty category (אב/פטור/etc.) or 0.5 activity —
      // those categories affect the eligibility check below, not
      // whether an explicit "I'm not available at all" constraint counts.
      if (fullConstraint[name]) {
        skipped.push(name + ' (אילוץ מלא החודש)');
        continue;
      }

      var cat = String(p.dutyCategory||'').trim();
      if (AVG_EXCLUDED_CATEGORIES.indexOf(cat) !== -1) continue; // structurally blocked from any day — not informative
      if (activity === '0.5') continue;                          // paternity cadence — separate 2-month rule, not a "skip"

      // Every remaining eligible person who received zero duty this month is
      // flagged — not only those already at/above the group average. With more
      // active tornim than daily duty slots, some eligible people miss out on
      // both the main duty and reserve every month; this banner should surface
      // all of them, not just the ones who "should" have had priority by score.
      skipped.push(name);
    }
    return skipped;
  } catch(e) {
    Logger.log('computeSkippedTornim error: ' + e);
    return [];
  }
}

function actionUpdateScheduleEntry(req) {
  const month = String(req.month || '').trim();
  const {date, v, a, b, notes, dutyType, v2, a2, b2, trainee} = req;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const TZ = ss.getSpreadsheetTimeZone();
  const sheet = ss.getSheetByName('Schedule_' + month);
  if (!sheet) return {success: false, error: 'לוח לא נמצא: Schedule_' + month};
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    // Normalize row date to dd/MM/yyyy
    const rowDate = rows[i][0] instanceof Date ?
      Utilities.formatDate(rows[i][0], TZ, 'dd/MM/yyyy') : String(rows[i][0]).trim();
    // Normalize request date (could be dd/MM/yyyy or yyyy-MM-dd)
    var reqDate = String(date).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(reqDate)) {
      var p = reqDate.split('-');
      reqDate = p[2] + '/' + p[1] + '/' + p[0];
    }
    if (rowDate !== reqDate) continue;

    const oldV = String(rows[i][3]||'').trim();
    const oldScore = Number(rows[i][8])||0;
    const oldDutyType = String(rows[i][7]||'חול');

    // ---- Compute the final row ONCE, write it in a SINGLE batched call ----
    // (individual setValue calls are ~0.5-1.5s each on Apps Script; batching
    //  ten of them into one setValues cuts save time from ~20s to ~3s)
    const finalV     = v     !== undefined ? v     : rows[i][3];
    const finalA     = a     !== undefined ? a     : rows[i][4];
    const finalB     = b     !== undefined ? b     : rows[i][5];
    const finalNotes = notes !== undefined ? notes : rows[i][6];
    let   finalType  = rows[i][7];
    let   finalScore = rows[i][8];
    const finalV2    = v2 !== undefined ? v2 : rows[i][9];
    const finalA2    = a2 !== undefined ? a2 : rows[i][10];
    const finalB2    = b2 !== undefined ? b2 : rows[i][11];
    const oldTrainee = String(rows[i][12]||'').trim();
    const finalT     = trainee !== undefined ? String(trainee||'').trim() : oldTrainee;

    // Duty type + score computation (side effects on Scores handled below)
    if (dutyType) {
      const dutyScores = getDutyTypesMap();
      const newScore = dutyScores[dutyType] || oldScore;
      finalType = dutyType;
      finalScore = newScore;
      // Adjust score if V changed or dutyType changed
      const newV = v !== undefined ? String(v||'').trim() : oldV;
      if (newV && (newV !== oldV || newScore !== oldScore)) {
        // Remove old score from old V
        if (oldV && oldV !== newV) updateScoreForSwap(oldV, '', month, oldScore, oldDutyType);
        else if (oldV && newScore !== oldScore) updateScoreForSwap(oldV, oldV, month, 0, oldDutyType);
        // Add new score to new V
        if (newV) {
          var scoreSheet = getScoresSheet(scoreYearOf(month));
          var scoreRows = scoreSheet.getDataRange().getValues();
          for (var si=1; si<scoreRows.length; si++) {
            if (String(scoreRows[si][0]).trim() === newV) {
              var cur = Number(scoreRows[si][3])||0;
              // If V changed: remove old from oldV (already done), add new to newV
              // If same V but score changed: adjust
              var diff = newScore - (newV === oldV ? oldScore : 0);
              scoreSheet.getRange(si+1,4).setValue(Math.max(0, cur + diff));
              Logger.log('Score adjusted: ' + newV + ' +' + diff);
              break;
            }
          }
        }
      }
    }

    // ---- ONE batched write for the whole row (cols D..M) ----
    sheet.getRange(i+1, 4, 1, 10).setValues([[
      finalV, finalA, finalB, finalNotes, finalType, finalScore,
      finalV2, finalA2, finalB2, finalT
    ]]);

    // 🎓 trainee bell notification (after the write)
    if (trainee !== undefined && finalT && finalT !== oldTrainee) {
      try {
        const mentor = String(finalV||'').trim();
        addSwapNotification(finalT,
          '🎓 שובצת לתורנות הסמכה בתאריך ' + rowDate +
          (mentor ? ' — מצטרף/ת למבצע ' + mentor : ''));
      } catch(e) { Logger.log('trainee notify: ' + e); }
    }

    const oldV2 = String(rows[i][9]||'').trim();

    // Score for V2: always recalculate when v2 changes
    var newV2 = v2 !== undefined ? String(v2||'').trim() : oldV2;
    Logger.log('V2 check: newV2="'+newV2+'" oldV2="'+oldV2+'" v2param='+JSON.stringify(v2));
    if (newV2 !== oldV2) {
      var dutyTypes2 = getDutyTypesMap();
      var effectiveDutyType = String(dutyType||'').trim() || String(oldDutyType||'').trim() || 'חול';
      var dayScore = Number(dutyTypes2[effectiveDutyType]) || Number(oldScore) || 10;
      Logger.log('V2 will change: "'+oldV2+'"→"'+newV2+'" dutyType='+effectiveDutyType+' score='+dayScore);
      Logger.log('V2 score change: "'+oldV2+'" -> "'+newV2+'" score='+dayScore+' type='+effectiveDutyType);
      
      // Remove score from old V2
      if (oldV2) {
        var sRows = getScoresSheet(scoreYearOf(month)).getDataRange().getValues();
        for (var j=1; j<sRows.length; j++) {
          if (String(sRows[j][0]||'').trim() === oldV2) {
            var oldAcc = Number(sRows[j][3])||0;
            getScoresSheet(scoreYearOf(month)).getRange(j+1, 4).setValue(Math.max(0, oldAcc - dayScore));
            Logger.log('V2 score removed from '+oldV2+': '+oldAcc+' -> '+Math.max(0, oldAcc-dayScore));
            break;
          }
        }
      }
      
      // Add score to new V2 - update acc2026 AND the monthly column
      if (newV2) {
        var sRows2 = getScoresSheet(scoreYearOf(month)).getDataRange().getValues(); // fresh read
        var found = false;
        // Determine which month column to update (col 4 = acc2026, monthly cols start at 5)
        // Month layout: col 5=ינואר סוג, 6=ינואר ניקוד, 7=פברואר סוג, 8=פברואר ניקוד...
        var reqMonth2 = String(month||'').trim();
        var monIdx = reqMonth2.length === 6 ? parseInt(reqMonth2.substring(4,6)) - 1 : -1; // 0=jan
        var monthScoreCol = monIdx >= 0 ? (4 + monIdx * 2 + 2) : -1; // 1-indexed: 6=jan,8=feb...
        
        for (var k=1; k<sRows2.length; k++) {
          if (String(sRows2[k][0]||'').trim() === newV2) {
            var curAcc2 = Number(sRows2[k][3])||0;
            // Update acc2026 (col 4)
            getScoresSheet(scoreYearOf(month)).getRange(k+1, 4).setValue(curAcc2 + dayScore);
            // Update monthly score column if available
            if (monthScoreCol > 0) {
              var curMonScore = Number(sRows2[k][monthScoreCol-1])||0;
              getScoresSheet(scoreYearOf(month)).getRange(k+1, monthScoreCol).setValue(curMonScore + dayScore);
              Logger.log('V2 monthly score col '+monthScoreCol+' +'+dayScore+' for '+newV2);
            }
            Logger.log('V2 score added to '+newV2+': '+curAcc2+' -> '+(curAcc2+dayScore));
            found = true;
            break;
          }
        }
        if (!found) Logger.log('V2 ERROR: could not find '+newV2+' in Scores sheet');
      }
    }

    return {success: true};
  }
  return {success: false, error: 'תאריך לא נמצא: ' + date + ' בלוח ' + month};
}

// ===== SCHEDULE GENERATION =====
function getDutyTypesMap() {
  const rows = getSheet(SH.DUTY_TYPES).getDataRange().getValues();
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0]) map[String(rows[i][0])] = Number(rows[i][1]) || 0;
  }
  return map;
}

function actionGenerateSchedule(req) {
  const month = String(req.month || '');
  const dayCategories = req.dayCategories;
  if (!dayCategories) return {success: false, error: 'dayCategories חסר'};

  const year = parseInt(month.substring(0, 4));
  const mon  = parseInt(month.substring(4, 6));
  const daysInMonth = new Date(year, mon, 0).getDate();

  // Load people (active, non-exempt)
  const allPeople = actionGetPeople().people;
  const activePeople = allPeople.filter(p => p.activity !== '0' && p.dutyCategory !== 'פטור');

  // Load accumulated scores as working copy
  const scoresData = actionGetScores().scores;
  const workingScores = {};
  scoresData.forEach(s => { workingScores[s.name] = Number(s.acc2026) || 0; });

  // Load constraints for this month
  const constraintsRes = actionGetAllConstraints({month});
  const constraints = constraintsRes.constraints || {};

  // Load duty type score table
  const dutyTypes = getDutyTypesMap();

  // ── Helpers ──────────────────────────────────────
  function getConstraintVal(name, day) {
    if (!constraints[name]) return '';
    return constraints[name].constraints[day - 1] || '';
  }

  function isHardBlocked(name, day) {
    // X = hard constraint (cannot serve)
    return getConstraintVal(name, day) === 'X';
  }

  function prefersDay(name, day) {
    // V = prefers this day (not binding but noted)
    return getConstraintVal(name, day) === 'V';
  }

  function canDoType(person, cat) {
    // לא מוסמך / פטור - לא משובצים
    if (person.dutyCategory === 'לא מוסמך' || person.dutyCategory === 'פטור') {
      return false;
    }
    // משרת אב - only חמישי types
    if (person.dutyCategory === 'אב') {
      return cat === 'חמישי' || cat === 'חמישי 24 שעות';
    }
    return true;
  }

  // ── Load history for gap rules ──────────────────
  // Get all schedule sheets for current + past months to check frequency
  function getRecentAssignments(personName, monthsBack) {
    var result = [];
    var y = year, mo = mon;
    for (var k = 0; k < monthsBack; k++) {
      mo--;
      if (mo < 1) { mo = 12; y--; }
      var shName = 'Schedule_' + y + String(mo).padStart(2,'0');
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(shName);
      if (!sh) continue;
      var rows = sh.getDataRange().getValues();
      for (var i = 1; i < rows.length; i++) {
        var v = String(rows[i][3]||'').trim();
        var a = String(rows[i][4]||'').trim();
        var b = String(rows[i][5]||'').trim();
        var dtype = String(rows[i][7]||'').trim();
        if (v===personName||a===personName||b===personName) {
          result.push({monthsAgo: k+1, dutyType: dtype, role: v===personName?'V':a===personName?'A':'B'});
        }
      }
    }
    return result;
  }

  // Check if אב served in last 2 months (max once per 2 months)
  function avServedLastMonth(name) {
    for (var back = 1; back <= 2; back++) {
      var prevMo = mon - back, prevY = year;
      while (prevMo < 1) { prevMo += 12; prevY--; }
      var shName = 'Schedule_' + prevY + String(prevMo).padStart(2,'0');
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(shName);
      if (!sh) continue;
      var rows = sh.getDataRange().getValues();
      for (var i = 1; i < rows.length; i++) {
        var v=String(rows[i][3]||'').trim(), a=String(rows[i][4]||'').trim(), b=String(rows[i][5]||'').trim();
        if (v===name||a===name||b===name) return true;
      }
    }
    return false;
  }

  // Check current month assignments count
  var monthAssignmentCount = {}; // name → count this month

  // Check if person did weekend in last N months
  function didWeekendInLastMonths(name, months) {
    var hist = getRecentAssignments(name, months);
    return hist.some(function(h) {
      return h.dutyType.includes('סוף שבוע') || h.dutyType === 'שבת';
    });
  }

  // Returns list sorted by score (lowest first), respecting hard constraints
  // Bonus: people who prefer this day are sorted higher (lower in list = preferred)
  function getEligible(day, cat) {
    return activePeople
      .filter(p => !isHardBlocked(p.name, day) && canDoType(p, cat))
      .sort((a, b) => {
        const scoreDiff = (workingScores[a.name] || 0) - (workingScores[b.name] || 0);
        if (scoreDiff !== 0) return scoreDiff;
        // Tiebreak: prefer those who marked V for this day
        const aV = prefersDay(a.name, day) ? -1 : 0;
        const bV = prefersDay(b.name, day) ? -1 : 0;
        return aV - bV;
      });
  }

  // ── Build day list ────────────────────────────────
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, mon - 1, d);
    const dow = date.getDay();
    const cat = String(dayCategories[String(d)] || (dow === 4 ? 'חמישי' : (dow === 5 || dow === 6) ? 'סוף שבוע' : 'חול'));
    days.push({day: d, date, dow, cat, hebrewDay: HEBREW_DAYS[dow]});
  }

  const assignment = {};

  // PURE SCORE-BASED: every day by lowest accumulated score
  // מלא people get Fri+Sat together (score 40)
  // בנפרד people get each day separately (score 20 each)
  // The 3 picked per day are ALWAYS the lowest scorers regardless of type

  days.forEach(({day, dow, cat, hebrewDay}) => {
    if (assignment[day]) return; // already assigned (e.g. Sat after full weekend)

    const nextDay = days.find(d => d.day === day + 1);
    const isFriday = dow === 5 && cat === 'סוף שבוע' &&
                     nextDay && nextDay.cat === 'סוף שבוע';

    if (isFriday) {
      // Build combined pool: מלא (eligible for full weekend) + בנפרד (Friday only)
      const elFull = activePeople
        .filter(p => p.weekendType !== 'בנפרד' &&
          !isHardBlocked(p.name, day) && !isHardBlocked(p.name, day+1))
        .map(p => ({name:p.name, full:true, score:workingScores[p.name]||0}));

      const elSep = activePeople
        .filter(p => p.weekendType === 'בנפרד' && !isHardBlocked(p.name, day))
        .map(p => ({name:p.name, full:false, score:workingScores[p.name]||0}));

      // Merge and sort by score (lowest first)
      const all = [...elFull, ...elSep].sort((a,b) => a.score - b.score);
      const top = all.slice(0, 3);

      const vP = top[0], aP = top[1], bP = top[2];
      const v = vP?.name || '', a = aP?.name || '', b = bP?.name || '';

      if (vP?.full) {
        // V does full weekend: same trio for both Fri+Sat, score 40
        const score = dutyTypes['סוף שבוע מלא'] || 40;
        assignment[day]   = {V:v, A:a, B:b, type:'סוף שבוע מלא', score, hebrewDay:HEBREW_DAYS[5], cat};
        assignment[day+1] = {V:v, A:a, B:b, type:'סוף שבוע מלא', score:0, hebrewDay:HEBREW_DAYS[6], cat:'סוף שבוע'};
        if (v) workingScores[v] = (workingScores[v]||0) + score;
      } else {
        // V is בנפרד — does Friday only, score 20
        const score = dutyTypes['סוף שבוע'] || 20;
        assignment[day] = {V:v, A:a, B:b, type:'סוף שבוע', score, hebrewDay:HEBREW_DAYS[5], cat};
        if (v) workingScores[v] = (workingScores[v]||0) + score;
        // Saturday left unassigned — will be picked up in the next iteration
      }
      return;
    }

    // All other days (incl. Saturday if not full-weekend): pure score
    const score = dutyTypes[cat] || 10;
    const el = getEligible(day, cat);
    const v = el[0]?.name || '', a = el[1]?.name || '', b = el[2]?.name || '';
    assignment[day] = {V:v, A:a, B:b, type:cat, score, hebrewDay, cat};
    if (v) {
      workingScores[v] = (workingScores[v]||0) + score;
      monthAssignmentCount[v] = (monthAssignmentCount[v]||0) + 1;
    }
  });

  // ── Save to Sheet (preserve holidays/notes from existing sheet) ──────
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = 'Schedule_' + month;
  let sched = ss.getSheetByName(sheetName);
  
  if (!sched) {
    // No existing sheet - create fresh
    sched = ss.insertSheet(sheetName);
    sched.setRightToLeft(true);
    const headers = ['תאריך','יום','סוג יום','מבצע','עתודה א','עתודה ב','הערות','סוג תורנות','ניקוד','מבצע שני','עתודה א שנייה','עתודה ב שנייה'];
    sched.getRange(1,1,1,headers.length).setValues([headers]);
    const schedRows = days.map(({day, hebrewDay, cat}) => {
      const ag = assignment[day] || {V:'',A:'',B:'',type:cat,score:0,hebrewDay};
      const date = new Date(year, mon-1, day);
      return [
        Utilities.formatDate(date,'Asia/Jerusalem','dd/MM/yyyy'),
        ag.hebrewDay||hebrewDay, ag.cat||cat,
        ag.V||'', ag.A||'', ag.B||'', '',
        ag.type||cat, ag.score||0
      ];
    });
    sched.getRange(2,1,schedRows.length,headers.length).setValues(schedRows);
  } else {
    // Existing sheet - batch update V/A/B/score only (preserve dayType + notes/holidays)
    const existingData = sched.getDataRange().getValues();
    const numRows = existingData.length - 1;
    if (numRows <= 0) return {success:false, error:'הלוח ריק'};

    // Build batch arrays for cols 4,5,6 (V,A,B) and col 9 (score)
    const vabUpdates = [];  // [V, A, B] per row
    const scoreUpdates = []; // [score] per row

    for (let i = 1; i <= numRows; i++) {
      const rowDate = existingData[i][0];
      const dayNum = rowDate instanceof Date ? rowDate.getDate() :
        parseInt(String(rowDate).split('/')[0]);
      const ag = (dayNum && assignment[dayNum]) || {V:'',A:'',B:'',score:0};
      vabUpdates.push([ag.V||'', ag.A||'', ag.B||'']);
      scoreUpdates.push([ag.score||0]);
    }

    // Single batch write for V/A/B (cols 4-6)
    sched.getRange(2, 4, numRows, 3).setValues(vabUpdates);
    // Single batch write for score (col 9)
    sched.getRange(2, 9, numRows, 1).setValues(scoreUpdates);
  }

  // ── Build response ────────────────────────────────
  const schedule = days.map(({day, hebrewDay, cat}) => {
    const ag = assignment[day] || {};
    const date = new Date(year, mon-1, day);
    return {
      date: Utilities.formatDate(date,'Asia/Jerusalem','yyyy-MM-dd'),
      day: ag.hebrewDay||hebrewDay, dayType: ag.cat||cat,
      v: ag.V||'', a: ag.A||'', b: ag.B||'',
      notes:'', dutyType: ag.type||cat, score: ag.score||0
    };
  });

  return {success: true, schedule, month};
}

// ===== INIT SHEETS =====
function actionInitSheets() {
  initSessions(); initUsers(); initPeople(); initDutyTypes(); initScores();
  return {success: true, message: 'כל הגיליונות אותחלו בהצלחה!'};
}

function initSessions() {
  const sh = getSheet(SH.SESSIONS);
  sh.clearContents();
  sh.getRange(1,1,1,6).setValues([['Token','Username','Name','Role','Created','Expires']]);
}

function initUsers() {
  const sh = getSheet(SH.USERS);
  sh.clearContents();
  sh.setRightToLeft(true);
  sh.getRange(1,1,1,6).setValues([['ID','שם','שם משתמש','סיסמה','תפקיד','פעיל']]);
  sh.appendRow([Utilities.getUuid().substring(0,8), 'מנהל מערכת', 'admin', hashPass('admin123'), 'admin', true]);
}

function initPeople() {
  const sh = getSheet(SH.PEOPLE);
  sh.clearContents();
  sh.setRightToLeft(true);
  sh.getRange(1,1,1,6).setValues([['שם','פעילות','סוג תורנות','טלפון','סוג סוף שבוע','אימייל']]);
  const people = [
    ['אהרון ריסין','1','','543005842'],['איתי גרטל','1','','544996678'],
    ['אלון אשורוב','1','','543295450'],['בן דקל','1','','542029111'],
    ['גיא מונט','1','','503994399'],['גל סטי','1','','506575389'],
    ['גל איזנברגר','1','','052-305-5642'],['דניאל הרשקוביץ','1','','050-966-9933'],
    ['דניאל מלול','1','','545499791'],['הוד סטרול','1','','584885822'],
    ['הראל סיבוני','1','','544948399'],['זיו יוסף','1','','508851767'],
    ['יגאל לביא','1','','529277176'],['יהונתן אנגל','1','','526087953'],
    ['יהונתן דוד פור','1','','509221812'],['יואב מטרני','1','','526512171'],
    ['יובל הופמן','0','אב','547833991'],['יובל וולטמן','1','','543924033'],
    ['יובל נסים טויאטו','1','','528811845'],['יוסף עזראן','1','','538289188'],
    ['לידור סבג','0.5','אב','526444337'],['מיכאלה כהן','1','','509566050'],
    ['מתן סרי','1','','547191477'],['נוריאל ביטון','1','','543051783'],
    ['עומר יצחקי','1','','506659941'],['עידן פרץ','1','','544280337'],
    ['עמית אילוז','1','','503511155'],['עמית לביא','1','','544530513'],
    ['ענבר שמיר','1','','502797966'],['ערן לפושניאן','0','פטור','544762081'],
    ['פארוק אברהים','1','','525507936'],['רון יחיד','1','','544484376'],
    ['שגיא בוארון','1','','542515161'],['בר סרגיינקו','1','','050-723-2244'],
  ];
  sh.getRange(2,1,people.length,4).setValues(people);
}

function initDutyTypes() {
  const sh = getSheet(SH.DUTY_TYPES);
  sh.clearContents();
  sh.setRightToLeft(true);
  sh.getRange(1,1,1,2).setValues([['סוג תורנות','ניקוד']]);
  const types = [
    ['דולג',0],['הדממה',18],['הדממה + חול',28],['הדממה + חמישי',30],
    ['חג',25],['חג + חול',35],['חג + חמישי',37],['חג + סוף שבוע',45],
    ['חול',10],['חול + חול',24],['חול + חמישי',22],['חול + שבת',30],
    ['חול 24 שעות',15],['חול 24 שעות + חול',25],['חול 24 שעות + חול 24 שעות',30],
    ['חול 24 שעות + חמישי',31],['חול 24 שעות + שבת',35],
    ['חמישי',12],['חמישי 24 שעות',16],['חמישי 24 שעות + חול',26],
    ['חמישי הדממה',19],['יומיים חג',50],
    ['סוף שבוע',20],['סוף שבוע + חול',36],['סוף שבוע + חמישי',32],
    ['סוף שבוע מלא',40],['סוף שבוע מלא + חול',50],
    ['ערב חג',25],['פטור',10],['שבת הקפצה',30],
  ];
  sh.getRange(2,1,types.length,2).setValues(types);
}

function initScores() {
  const sh = getScoresSheet(String(new Date().getFullYear()));
  sh.clearContents();
  sh.setRightToLeft(true);
  const hdrs = ['שם','פעילות','מצטבר 2025','מצטבר 2026',
    'ינואר סוג','ינואר ניקוד','פברואר סוג','פברואר ניקוד',
    'מרץ סוג','מרץ ניקוד','אפריל סוג','אפריל ניקוד',
    'מאי סוג','מאי ניקוד','יוני סוג','יוני ניקוד',
    'יולי סוג','יולי ניקוד','אוגוסט סוג','אוגוסט ניקוד',
    'ספטמבר סוג','ספטמבר ניקוד','אוקטובר סוג','אוקטובר ניקוד',
    'נובמבר סוג','נובמבר ניקוד','דצמבר סוג','דצמבר ניקוד'];
  sh.getRange(1,1,1,hdrs.length).setValues([hdrs]);

  const data = [
    ['אהרון ריסין','1',616,693,'חול',10,'חול',12,'חול',10,'חג + חול',35,'חול',10,'','','','','','','','','','','','','',''],
    ['איתי גרטל','1',614,694,'סוף שבוע',20,'חול',10,'סוף שבוע',20,'חול',10,'סוף שבוע',20,'','','','','','','','','','','','','',''],
    ['אלון אשורוב','1',624,694,'דולג',0,'סוף שבוע',20,'סוף שבוע',20,'סוף שבוע',20,'חול',10,'','','','','','','','','','','','','',''],
    ['בן דקל','1',616,715,'חמישי',12,'חול',10,'חול 24 שעות + חול',25,'חמישי',12,'סוף שבוע מלא',40,'','','','','','','','','','','','','',''],
    ['גיא מונט','1',614,702,'סוף שבוע מלא',40,'דולג',0,'חול',10,'הדממה + חול',28,'חול',10,'','','','','','','','','','','','','',''],
    ['גל איזנברגר','1',688,708,'','',0,'','',0,'','',0,'','',0,'סוף שבוע',20,'','','','','','','','','','',''],
    ['גל סטי','1',614,694,'סוף שבוע',20,'חול',10,'סוף שבוע',20,'דולג',0,'ערב חג',30,'','','','','','','','','','','','','',''],
    ['דניאל הרשקוביץ','1',688,708,'','',0,'','',0,'','',0,'','',0,'סוף שבוע',20,'','','','','','','','','','',''],
    ['דניאל מלול','1',616,705,'חול',10,'סוף שבוע',20,'חול 24 שעות + חמישי',31,'הדממה',18,'חול',10,'','','','','','','','','','','','','',''],
    ['הוד סטרול','1',615,728,'חול',10,'חמישי',12,'סוף שבוע מלא + חול',75,'דולג',0,'חמישי 24 שעות',16,'','','','','','','','','','','','','',''],
    ['הראל סיבוני','1',620,696,'חמישי',12,'חמישי',12,'חמישי',12,'סוף שבוע מלא',40,'דולג',0,'','','','','','','','','','','','','',''],
    ['זיו יוסף','1',610,696,'חמישי',12,'סוף שבוע',20,'חול + חול',24,'סוף שבוע',20,'חול',10,'','','','','','','','','','','','','',''],
    ['יגאל לביא','1',629,741,'דולג',0,'חול',10,'חול 24 שעות + שבת',35,'חג + חמישי',37,'שבת הקפצה',30,'','','','','','','','','','','','','',''],
    ['יהונתן אנגל','1',617,712,'חול',10,'חול',10,'חול 24 שעות + חול',25,'סוף שבוע מלא',40,'חול',10,'','','','','','','','','','','','','',''],
    ['יהונתן דוד פור','1',614,698,'סוף שבוע',20,'חול',10,'חמישי',12,'סוף שבוע + חמישי',32,'חול',10,'','','','','','','','','','','','','',''],
    ['יואב מטרני','1',688,688,'','',0,'','',0,'','',0,'','',0,'דולג',0,'','','','','','','','','','',''],
    ['יובל הופמן','0',0,0,'פטור',10,'פטור',10,'פטור',10,'פטור',10,'חמישי',12,'','','','','','','','','','','','','',''],
    ['יובל וולטמן','1',618,698,'סוף שבוע',20,'חול',10,'סוף שבוע',20,'סוף שבוע',20,'חול',10,'','','','','','','','','','','','','',''],
    ['יובל נסים טויאטו','1',612,684,'חול',10,'דולג',0,'סוף שבוע מלא',40,'חמישי',12,'חול',10,'','','','','','','','','','','','','',''],
    ['יוסף עזראן','1',630,718,'חול',10,'סוף שבוע מלא',40,'חול',10,'הדממה',18,'חול',10,'','','','','','','','','','','','','',''],
    ['לידור סבג','0.5',0,0,'חמישי',12,'דולג',0,'חמישי',12,'דולג',0,'חמישי',12,'','','','','','','','','','','','','',''],
    ['מיכאלה כהן','1',616,710,'חול',10,'דולג',0,'חול + חול',24,'יומיים חג',50,'חול',10,'','','','','','','','','','','','','',''],
    ['מתן סרי','1',619,712.2,'חול',10,'חול',10,'סוף שבוע + חול',43.2,'חול',10,'סוף שבוע',20,'','','','','','','','','','','','','',''],
    ['נוריאל ביטון','1',619,709,'חול',10,'חול',10,'חול 24 שעות + חול 24 שעות',30,'סוף שבוע מלא',40,'דולג',0,'','','','','','','','','','','','','',''],
    ['עומר יצחקי','1',615,717,'חול',10,'חמישי 24 שעות + חול',26,'סוף שבוע',20,'סוף שבוע + חול',36,'חול',10,'','','','','','','','','','','','','',''],
    ['עידן פרץ','1',629,694,'','',0,'חול',10,'חול',10,'חג + חול',35,'חול',10,'','','','','','','','','','','','','',''],
    ['עמית אילוז','1',629,690,'','',0,'','',0,'','',0,'סוף שבוע + חול',36,'חול 24 שעות + חול',25,'','','','','','','','','','','',''],
    ['עמית לביא','1',613,683,'סוף שבוע מלא',40,'דולג',0,'חול',10,'חול',10,'חול',10,'','','','','','','','','','','','','',''],
    ['ענבר שמיר','1',615,695,'סוף שבוע',20,'דולג',0,'חול + שבת',30,'דולג',0,'חג',25,'','','','','','','','','','','','','',''],
    ['ערן לפושניאן','0',618,683,'חול',10,'חול',10,'סוף שבוע',20,'חג',25,'דולג',0,'','','','','','','','','','','','','',''],
    ['פארוק אברהים','1',623,716,'חול',10,'חמישי',12,'דולג',0,'חג + חול',35,'סוף שבוע + חול',36,'','','','','','','','','','','','','',''],
    ['רון יחיד','1',596,708,'חמישי',12,'סוף שבוע',40,'חול 24 שעות + חול',25,'חג + חול',35,'דולג',0,'','','','','','','','','','','','','',''],
    ['שגיא בוארון','1',620,698,'חול',10,'חול',10,'סוף שבוע',20,'הדממה',18,'סוף שבוע',20,'','','','','','','','','','','','','',''],
    ['בר סרגיינקו','1',702,702,'','',0,'','',0,'','',0,'','',0,'','',0,'','','','','','','','','','',''],
  ];
  if (data.length > 0) sh.getRange(2,1,data.length,28).setValues(data);
}

// ===== BOOTSTRAP (no auth required - only creates admin if sheet is empty) =====
function actionBootstrap() {
  try {
    const sh = getSheet(SH.USERS);
    const rows = sh.getDataRange().getValues();
    const hasUsers = rows.length > 1 && rows[1][2];
    if (hasUsers) {
      return {success: false, error: 'המערכת כבר מאותחלת. השתמש בפרטי הכניסה שלך.'};
    }
    actionInitSheets();
    return {success: true, message: 'המערכת אותחלה! התחבר עם admin / admin123'};
  } catch(e) {
    return {success: false, error: e.toString()};
  }
}

// הרץ פונקציה זו ישירות מעורך Apps Script לאתחול ידני
function manualInit() {
  actionInitSheets();
  Logger.log('סיום! התחבר עם admin / admin123');
}

// ===== UNIFIED TORANI MANAGEMENT =====
// Returns merged data from Users + People sheets
function actionGetAllTornim() {
  const usersRows = getSheet(SH.USERS).getDataRange().getValues();
  const peopleRows = getSheet(SH.PEOPLE).getDataRange().getValues();

  // Build people map by name
  const peopleMap = {};
  for (let i = 1; i < peopleRows.length; i++) {
    const [name, activity, dutyCategory, phone, weekendType, email, endDate,
      isMilitaryVehicle, vehicleCompany, vehicleModel, vehicleColor, vehiclePlate] = peopleRows[i];
    if (name) peopleMap[String(name)] = {
      activity: String(activity || '1'),
      dutyCategory: String(dutyCategory || ''),
      phone: String(phone || ''),
      weekendType: String(weekendType || 'מלא'),
      email: String(email || ''),
      endDate: endDate ? (endDate instanceof Date ? Utilities.formatDate(endDate, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(endDate).split('T')[0]) : '',
      isMilitaryVehicle: String(isMilitaryVehicle || '') === 'כן' ? 'כן' : 'לא',
      vehicleCompany: String(vehicleCompany || ''),
      vehicleModel: String(vehicleModel || ''),
      vehicleColor: String(vehicleColor || ''),
      vehiclePlate: String(vehiclePlate || ''),
      peopleRow: i + 1
    };
  }

  const tornim = [];
  for (let i = 1; i < usersRows.length; i++) {
    const [id, name, username, , role, active] = usersRows[i];
    if (!username) continue;
    const p = peopleMap[String(name)] || {};
    tornim.push({
      id, name: String(name), username: String(username),
      role: String(role || 'user'), active: !!active,
      activity: p.activity || '1',
      dutyCategory: p.dutyCategory || '',
      phone: p.phone || '',
      email: p.email || '',
      weekendType: p.weekendType || 'מלא',
      endDate: p.endDate || '',
      isMilitaryVehicle: p.isMilitaryVehicle || 'לא',
      vehicleCompany: p.vehicleCompany || '',
      vehicleModel: p.vehicleModel || '',
      vehicleColor: p.vehicleColor || '',
      vehiclePlate: p.vehiclePlate || '',
      hasPeopleEntry: !!peopleMap[String(name)]
    });
  }
  return {success: true, tornim};
}

// ===== ADMIN HOME DASHBOARD (single round-trip) =====
// Collapses the admin home page's ~9 separate requests into ONE call:
// current+next schedule, swaps, tornim, recent audit, people, and the open
// constraint month + its constraints. validateToken runs once instead of ~9
// times, and the fixed network/Apps-Script overhead is paid once, not per call.
// Internally it just orchestrates the existing action functions, so their
// return shapes are preserved exactly (the frontend render fns expect them).
function actionGetAdminDashboard(req, user) {
  function nextM(m, add) {
    var y  = parseInt(m.substring(0, 4), 10);
    var mo = parseInt(m.substring(4, 6), 10) + add;
    y  += Math.floor((mo - 1) / 12);
    mo  = ((mo - 1) % 12 + 12) % 12 + 1;
    return String(y) + (mo < 10 ? '0' + mo : '' + mo);
  }
  var month = String(req.month || '');
  var next  = nextM(month, 1);

  var out = {
    success:      true,
    month:        month,
    nextMonth:    next,
    schedule:     actionGetSchedule({month: month}, user),
    nextSchedule: actionGetSchedule({month: next},  user),
    swaps:        actionGetSwaps(req, user),
    tornim:       actionGetAllTornim(),
    audit:        actionGetAuditLog({limit: 5}),
    people:       actionGetPeople()
  };

  // Resolve the open constraint month server-side (was up to 3 getLockStatus calls)
  var candidates = [next, nextM(month, 2), month];
  var openMonth = null;
  for (var i = 0; i < candidates.length; i++) {
    var ls = actionGetLockStatus({month: candidates[i]});
    if (ls && ls.success && !ls.locked) { openMonth = candidates[i]; break; }
  }
  out.openMonth   = openMonth;
  out.constraints = openMonth ? actionGetAllConstraints({month: openMonth}) : null;

  return out;
}

function actionAddTorani(req) {
  const {username, password, role, activity, dutyCategory, phone, weekendType, email, endDate} = req;
  // Strip geresh/apostrophes from names — they break single-quoted JS strings and HTML attributes
  const name = String(req.name || '').replace(/['\u05f3\u2019]/g, '').trim();
  if (!name || !username || !password) return {success: false, error: 'חסרים שדות חובה: שם, שם משתמש, סיסמה'};

  // Check username unique
  const usersSheet = getSheet(SH.USERS);
  const usersRows = usersSheet.getDataRange().getValues();
  for (let i = 1; i < usersRows.length; i++) {
    if (String(usersRows[i][2]).toLowerCase() === String(username).toLowerCase())
      return {success: false, error: 'שם המשתמש כבר קיים'};
  }

  // Add to Users
  usersSheet.appendRow([
    Utilities.getUuid().substring(0,8), name, username,
    hashPass(password), role || 'user', true
  ]);

  // Add/update People
  const vf = normalizeVehicleFields(req);
  const peopleSheet = getSheet(SH.PEOPLE);
  const peopleRows = peopleSheet.getDataRange().getValues();
  let found = false;
  for (let i = 1; i < peopleRows.length; i++) {
    if (String(peopleRows[i][0]) === String(name)) {
      peopleSheet.getRange(i+1,2).setValue(activity || '1');
      peopleSheet.getRange(i+1,3).setValue(dutyCategory || '');
      peopleSheet.getRange(i+1,4).setValue(phone || '');
      peopleSheet.getRange(i+1,5).setValue(weekendType || 'מלא');
      if (endDate !== undefined) peopleSheet.getRange(i+1,7).setValue(endDate || '');
      peopleSheet.getRange(i+1,8,1,5).setValues([[vf.isMilitaryVehicle, vf.vehicleCompany, vf.vehicleModel, vf.vehicleColor, vf.vehiclePlate]]);
      found = true; break;
    }
  }
  if (!found) {
    peopleSheet.appendRow([name, activity||'1', dutyCategory||'', phone||'', weekendType||'מלא', email||'', endDate||'',
      vf.isMilitaryVehicle, vf.vehicleCompany, vf.vehicleModel, vf.vehicleColor, vf.vehiclePlate]);
  }

  // Set starting score = average of all active tornim (fair entry into rotation)
  const avgScore = calcAverageScore();
  const scoreSheet = getScoresSheet(scoreYearOf(null));
  const scoreRows = scoreSheet.getDataRange().getValues();
  let foundInScores = false;
  for (let i = 1; i < scoreRows.length; i++) {
    if (String(scoreRows[i][0]||'').trim() === String(name).trim()) {
      foundInScores = true;
      break;
    }
  }
  if (!foundInScores) {
    scoreSheet.appendRow([name, activity||'1', 0, avgScore]);
    Logger.log('New torani ' + name + ' → avg score: ' + avgScore);
  }

  return {success: true, message: 'תורן נוסף. ניקוד התחלתי: ' + avgScore};
}

// ===== חישוב ממוצע ניקוד — רק תורנים שנושאים בנטל מלא =====
// A new torani's starting score is set to this average, so the average must
// reflect only people who actually carry a full share of the rotation.
// Previously it read the ACTIVITY column of the Scores sheet — but that value is
// written once, when the row is created, and is never synced again:
// actionUpdatePerson and actionUpdateTorani both write activity to the PEOPLE
// sheet only. A torani deactivated months ago therefore still counted. Worse,
// משרת אב / פטור / לא מוסמך live in People's dutyCategory column, which the old
// version never read at all — so they were always included, dragging the average
// down and handing every new torani an unearned head start in the queue.
// People is the single source of truth here.
var AVG_EXCLUDED_CATEGORIES = ['אב', 'פטור', 'לא מוסמך', 'טרם הוסמך', 'מנהל מערכת'];

function calcAverageScore() {
  var rows = getScoresSheet(scoreYearOf(null)).getDataRange().getValues();

  var peopleMap = {};
  try {
    var pres = actionGetPeople();
    if (pres && pres.people) {
      pres.people.forEach(function(p) { peopleMap[String(p.name || '').trim()] = p; });
    }
  } catch (e) {
    Logger.log('calcAverageScore: actionGetPeople failed — ' + e);
  }

  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var total = 0, count = 0;       // filtered average
  var fbTotal = 0, fbCount = 0;   // legacy average, kept as a fallback

  for (var i = 1; i < rows.length; i++) {
    var name = String(rows[i][0] || '').trim();
    if (!name) continue;

    var score = Number(rows[i][3]) || 0;
    if (score <= 0) continue;

    var scoresActivity = String(rows[i][1] || '1').trim();
    if (scoresActivity !== '0') { fbTotal += score; fbCount++; }

    var p        = peopleMap[name];
    var activity = p ? String(p.activity || '1').trim() : scoresActivity;
    var category = p ? String(p.dutyCategory || '').trim() : '';
    var endDate  = p ? String(p.endDate || '').trim() : '';

    if (activity === '0' || activity === '0.5') continue;           // לא פעיל / משרת הורה
    if (AVG_EXCLUDED_CATEGORIES.indexOf(category) !== -1) continue; // אב / פטור / לא מוסמך / מנהל
    if (endDate && endDate < todayStr) continue;                    // סיים שירות

    total += score;
    count++;
  }

  if (count > 0) return Math.round(total / count);

  // Nothing passed the filter (e.g. People failed to load, or every name mismatched).
  // Returning 0 here would put a new torani at the head of the queue for every
  // single duty, so fall back to the old calculation and leave a trace.
  Logger.log('calcAverageScore: filtered set empty, falling back to legacy average');
  return fbCount > 0 ? Math.round(fbTotal / fbCount) : 0;
}

function actionUpdateTorani(req) {
  const {username, role, newPassword, activity, dutyCategory, phone, weekendType, email, active, endDate, isMilitaryVehicle} = req;
  // Strip geresh/apostrophes from names — they break single-quoted JS strings and HTML attributes
  const name = req.name ? String(req.name).replace(/['\u05f3\u2019]/g, '').trim() : req.name;
  if (!username) return {success: false, error: 'חסר שם משתמש'};

  // Update Users sheet
  const usersSheet = getSheet(SH.USERS);
  const usersRows = usersSheet.getDataRange().getValues();
  let oldName = '';
  for (let i = 1; i < usersRows.length; i++) {
    if (String(usersRows[i][2]) === String(username)) {
      oldName = String(usersRows[i][1]);
      if (name) { usersSheet.getRange(i+1,2).setValue(name); }
      if (role) { usersSheet.getRange(i+1,5).setValue(role); }
      if (newPassword) { usersSheet.getRange(i+1,4).setValue(hashPass(newPassword)); }
      if (active !== undefined) { usersSheet.getRange(i+1,6).setValue(active); }
      break;
    }
  }

  // Update People sheet (by old name, then update to new name if changed)
  const lookupName = name && name !== oldName ? oldName : (name || oldName);
  const peopleSheet = getSheet(SH.PEOPLE);
  const peopleRows = peopleSheet.getDataRange().getValues();
  let found = false;
  for (let i = 1; i < peopleRows.length; i++) {
    if (String(peopleRows[i][0]) === String(lookupName)) {
      if (name) peopleSheet.getRange(i+1,1).setValue(name);
      if (activity !== undefined) peopleSheet.getRange(i+1,2).setValue(activity);
      if (dutyCategory !== undefined) peopleSheet.getRange(i+1,3).setValue(dutyCategory);
      if (phone !== undefined) peopleSheet.getRange(i+1,4).setValue(phone);
      if (weekendType !== undefined) peopleSheet.getRange(i+1,5).setValue(weekendType);
      if (email !== undefined) peopleSheet.getRange(i+1,6).setValue(email);
      if (endDate !== undefined) peopleSheet.getRange(i+1,7).setValue(endDate);
      // Only touch the vehicle columns when the vehicle form was actually part of
      // this submission — most updateTorani calls (phone-only, weekend-only,
      // password reset...) don't include isMilitaryVehicle and must leave it alone.
      if (isMilitaryVehicle !== undefined) {
        const vf = normalizeVehicleFields(req);
        peopleSheet.getRange(i+1,8,1,5).setValues([[vf.isMilitaryVehicle, vf.vehicleCompany, vf.vehicleModel, vf.vehicleColor, vf.vehiclePlate]]);
      }
      found = true; break;
    }
  }
  if (!found && lookupName) {
    const vf = normalizeVehicleFields(req);
    peopleSheet.appendRow([name||lookupName, activity||'1', dutyCategory||'', phone||'', weekendType||'מלא', email||'', endDate||'',
      vf.isMilitaryVehicle, vf.vehicleCompany, vf.vehicleModel, vf.vehicleColor, vf.vehiclePlate]);
  }

  return {success: true};
}

function actionToggleTorani(req) {
  const sheet = getSheet(SH.USERS);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] === req.username) {
      const current = !!rows[i][5];
      sheet.getRange(i+1,6).setValue(!current);
      return {success: true, active: !current};
    }
  }
  return {success: false, error: 'תורן לא נמצא'};
}

function actionDeleteTorani(req) {
  // Only deactivate, never delete data
  return actionToggleTorani({...req});
}

// ===== אתחול כל התורנים - הרץ פעם אחת מעורך Apps Script =====
function initAllTornim() {
  const tornim = [
    // [שם,           username,              סיסמה,        תפקיד, פעילות, קטגוריה,       סוף שבוע, טלפון]
    ['אהרון ריסין',   'aharon.risin',        'Tornut2026',  'user','1',   '',             'בנפרד', '543005842'],
    ['איתי גרטל',    'itai.gartel',          'Tornut2026',  'user','1',   '',             'בנפרד', '544996678'],
    ['אלון אשורוב',  'alon.ashurov',         'Tornut2026',  'user','1',   '',             'בנפרד', '543295450'],
    ['בן דקל',       'ben.dekel',            'Tornut2026',  'user','1',   '',             'מלא',   '542029111'],
    ['בר סרגיינקו',  'bar.sergienko',        'Tornut2026',  'user','0',   'טרם הוסמך',   'מלא',   '0507232244'],
    ['גיא מונט',     'guy.mont',             'Tornut2026',  'user','1',   '',             'מלא',   '503994399'],
    ['גל איזנברגר',  'gal.eizenberger',      'Tornut2026',  'user','0',   'טרם הוסמך',   'מלא',   '0523055642'],
    ['גל סטי',       'gal.sti',              'Tornut2026',  'user','1',   '',             'בנפרד', '506575389'],
    ['דניאל הרשקוביץ','daniel.hershkovitz',  'Tornut2026',  'user','1',   '',             'בנפרד', '0509669933'],
    ['דניאל מלול',   'daniel.malul',         'Tornut2026',  'user','1',   '',             'בנפרד', '545499791'],
    ['הוד סטרול',    'hod.strol',            'Tornut2026',  'user','1',   '',             'בנפרד', '584885822'],
    ['הראל סיבוני',  'harel.siboni',         'Tornut2026',  'user','1',   '',             'מלא',   '544948399'],
    ['זיו יוסף',     'ziv.yosef',            'Tornut2026',  'user','1',   '',             'בנפרד', '508851767'],
    ['יגאל לביא',    'yigal.lavi',           'Tornut2026',  'user','1',   '',             'בנפרד', '529277176'],
    ['יהונתן אנגל',  'yonatan.angel',        'Tornut2026',  'user','1',   '',             'מלא',   '526087953'],
    ['יהונתן דוד פור','yonatan.davidpour',   'Tornut2026',  'user','1',   '',             'בנפרד', '509221812'],
    ['יואב מטרני',   'yoav.matrani',         'Tornut2026',  'user','1',   '',             'מלא',   '526512171'],
    ['יובל הופמן',   'yuval.hoffman',        'Tornut2026',  'user','0',   'אב',           'מלא',   '547833991'],
    ['יובל וולטמן',  'yuval.voltman',        'Tornut2026',  'user','1',   '',             'בנפרד', '543924033'],
    ['יובל נסים טויאטו','yuval.toiyato',     'Tornut2026',  'user','1',   '',             'מלא',   '528811845'],
    ['יוסף עזראן',   'yosef.ezran',          'Tornut2026',  'user','1',   '',             'מלא',   '538289188'],
    ['לידור סבג',    'lidor.savag',          'Tornut2026',  'user','0.5', 'אב',           'מלא',   '526444337'],
    ['מיכאלה כהן',   'michaela.cohen',       'Tornut2026',  'user','1',   '',             'מלא',   '509566050'],
    ['מתן סרי',      'matan.seri',           'Tornut2026',  'user','1',   '',             'בנפרד', '547191477'],
    ['נוריאל ביטון',  'nuriel.biton',        'Tornut2026',  'user','1',   '',             'מלא',   '543051783'],
    ['עומר יצחקי',   'omer.yitzhaki',        'Tornut2026',  'user','1',   '',             'בנפרד', '506659941'],
    ['עידן פרץ',     'idan.peretz',          'Tornut2026',  'user','1',   '',             'בנפרד', '544280337'],
    ['עמית אילוז',   'amit.ilouz',           'Tornut2026',  'user','1',   '',             'בנפרד', '503511155'],
    ['עמית לביא',    'amit.lavi',            'Tornut2026',  'user','1',   '',             'מלא',   '544530513'],
    ['ענבר שמיר',    'inbar.shamir',         'Tornut2026',  'user','1',   '',             'בנפרד', '502797966'],
    ['ערן לפושניאן', 'eran.lapushniyan',     'Tornut2026',  'user','0',   'פטור',         'מלא',   '544762081'],
    ['פארוק אברהים', 'farouk.avraham',       'Tornut2026',  'user','1',   '',             'בנפרד', '525507936'],
    ['רון יחיד',     'ron.yahid',            'Tornut2026',  'user','1',   '',             'בנפרד', '544484376'],
    ['שגיא בוארון',  'sagi.buaron',          'Tornut2026',  'user','1',   '',             'בנפרד', '542515161'],
  ];

  const usersSheet = getSheet(SH.USERS);
  const peopleSheet = getSheet(SH.PEOPLE);

  // Clear existing data (keep headers)
  const usersLastRow = usersSheet.getLastRow();
  if (usersLastRow > 1) usersSheet.deleteRows(2, usersLastRow - 1);
  const peopleLastRow = peopleSheet.getLastRow();
  if (peopleLastRow > 1) peopleSheet.deleteRows(2, peopleLastRow - 1);

  // צור חשבון admin נפרד למנהל המערכת
  usersSheet.appendRow([
    Utilities.getUuid().substring(0,8),
    'מנהל מערכת', 'admin', hashPass('admin123'), 'admin', true
  ]);

  let added = 0;
  tornim.forEach(([name, username, password, role, activity, category, weekend, phone]) => {
    // Add to Users
    usersSheet.appendRow([
      Utilities.getUuid().substring(0,8),
      name, username, hashPass(password), role, true
    ]);
    // Add to People
    peopleSheet.appendRow([name, activity, category, phone, weekend]);
    added++;
  });

  Logger.log('✅ נוספו ' + added + ' תורנים. סיסמה ברירת מחדל: Tornut2026');
  return 'נוספו ' + added + ' תורנים בהצלחה!';
}

// ===== לוח יוני 2026 - קריאה אוטומטית מהתמונה =====
function initJuneSchedule2026() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = 'Schedule_202606';
  const existing = ss.getSheetByName(sheetName);
  if (existing) ss.deleteSheet(existing);
  const sheet = ss.insertSheet(sheetName);
  sheet.setRightToLeft(true);

  const headers = ['תאריך','יום','סוג יום','מבצע','עתודה א','עתודה ב','הערות','סוג תורנות','ניקוד','מבצע שני','עתודה א שנייה','עתודה ב שנייה'];
  sheet.getRange(1,1,1,headers.length).setValues([headers]);

  const HEB_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

  const dayTypes = {
    1:'חול',2:'חול',3:'חול',4:'חמישי',5:'סוף שבוע',6:'סוף שבוע',
    7:'חול',8:'חול',9:'חול',10:'חול 24 שעות',11:'חמישי 24 שעות',
    12:'סוף שבוע',13:'סוף שבוע',14:'חול',15:'חול',16:'חול',17:'חול',
    18:'חמישי',19:'סוף שבוע',20:'סוף שבוע',21:'חול',22:'חול',23:'חול',
    24:'חול',25:'חמישי',26:'סוף שבוע',27:'סוף שבוע',28:'חול',29:'חול',30:'חול'
  };

  const dutyScores = {
    'חול':10,'חמישי':12,'סוף שבוע':20,'חול 24 שעות':15,'חמישי 24 שעות':16,'סוף שבוע מלא':40
  };

  const assignments = {
    1:  {V:'אלון אשורוב',      A:'יובל וולטמן',      B:'דניאל הרשקוביץ'},
    2:  {V:'גל סטי',           A:'מתן סרי',           B:'בן דקל'},
    3:  {V:'זיו יוסף',         A:'גיא מונט',          B:'יהונתן אנגל'},
    4:  {V:'הראל סיבוני',      A:'עמית לביא',         B:'יובל נסים טויאטו'},
    5:  {V:'עידן פרץ',         A:'עומר יצחקי',        B:'רון יחיד'},
    6:  {V:'בר סרגיינקו',      A:'רון יחיד',          B:'עמית אילוז'},
    7:  {V:'יהונתן דוד פור',   A:'זיו יוסף',          B:'גל איזנברגר'},
    8:  {V:'יובל וולטמן',      A:'דניאל הרשקוביץ',   B:'נוריאל ביטון'},
    9:  {V:'שגיא בוארון',      A:'מיכאלה כהן',        B:'פארוק אברהים'},
    10: {V:'גיא מונט',         A:'יהונתן אנגל',       B:'יהונתן דוד פור'},
    11: {V:'עמית לביא',        A:'יובל נסים טויאטו',  B:'הראל סיבוני'},
    12: {V:'יואב מטרני',       A:'שגיא בוארון',       B:'מתן סרי'},
    13: {V:'יואב מטרני',       A:'שגיא בוארון',       B:'מתן סרי'},
    14: {V:'איתי גרטל',        A:'גל סטי',            B:'אהרון ריסין'},
    15: {V:'גל איזנברגר',      A:'יגאל לביא',         B:'יובל וולטמן'},
    16: {V:'ענבר שמיר',        A:'פארוק אברהים',      B:'יואב מטרני'},
    17: {V:'נוריאל ביטון',     A:'בן דקל',            B:'גיא מונט'},
    18: {V:'עמית אילוז',       A:'הראל סיבוני',       B:'זיו יוסף'},
    19: {V:'רון יחיד',         A:'ענבר שמיר',         B:'בר סרגיינקו'},
    20: {V:'אהרון ריסין',      A:'עידן פרץ',          B:'דניאל מלול'},
    21: {V:'דניאל הרשקוביץ',  A:'גל איזנברגר',       B:'גל סטי'},
    22: {V:'מיכאלה כהן',       A:'יהונתן דוד פור',   B:'שגיא בוארון'},
    23: {V:'יהונתן אנגל',      A:'נוריאל ביטון',      B:'יגאל לביא'},
    24: {V:'מתן סרי',          A:'עמית אילוז',        B:'עמית לביא'},
    25: {V:'יובל נסים טויאטו', A:'אהרון ריסין',       B:'מיכאלה כהן'},
    26: {V:'עומר יצחקי',       A:'אלון אשורוב',       B:'איתי גרטל'},
    27: {V:'עומר יצחקי',       A:'בר סרגיינקו',       B:'עידן פרץ'},
    28: {V:'בן דקל',           A:'יואב מטרני',        B:'ענבר שמיר'},
    29: {V:'פארוק אברהים',     A:'יגאל לביא',         B:'דניאל מלול'},
    30: {V:'אלון אשורוב',      A:'פארוק אברהים',      B:'איתי גרטל'}
  };

  const rows = [];
  for (let d = 1; d <= 30; d++) {
    const date = new Date(2026, 5, d);
    const dow = date.getDay();
    const a = assignments[d] || {V:'',A:'',B:''};
    const dtype = dayTypes[d] || 'חול';
    rows.push([
      Utilities.formatDate(date,'Asia/Jerusalem','dd/MM/yyyy'),
      HEB_DAYS[dow], dtype,
      a.V||'', a.A||'', a.B||'', '',
      dtype, dutyScores[dtype]||10
    ]);
  }

  sheet.getRange(2,1,rows.length,headers.length).setValues(rows);
  Logger.log('✅ לוח יוני 2026 נוצר עם 30 ימים + שיבוצים מלאים!');
  return 'לוח יוני 2026 נוצר בהצלחה!';
}

// ===== לוח חגים ומועדים ישראל 2026 =====
function getIsraeliHolidays2026() {
  // תאריכים מאומתים מול Hebcal.com (גרסת ישראל) — אוגוסט 2026
  // הערה: בישראל פסח/שבועות/סוכות הם יום חג אחד (לא יומיים כמו בגולה)
  return {
    '2026-03-02': {type:'ערב חג', name:'תענית אסתר'},
    '2026-03-03': {type:'חג', name:'פורים'},
    '2026-04-01': {type:'ערב חג', name:'ערב פסח'},
    '2026-04-02': {type:'חג', name:'פסח א׳'},
    '2026-04-03': {type:'חג', name:'חוה״מ פסח'},
    '2026-04-04': {type:'חג', name:'חוה״מ פסח'},
    '2026-04-05': {type:'חג', name:'חוה״מ פסח'},
    '2026-04-06': {type:'חג', name:'חוה״מ פסח'},
    '2026-04-07': {type:'ערב חג', name:'ערב שביעי של פסח'},
    '2026-04-08': {type:'חג', name:'שביעי של פסח'},
    '2026-04-20': {type:'ערב חג', name:'יום הזיכרון'},
    '2026-04-21': {type:'חג', name:'יום העצמאות'},
    '2026-05-21': {type:'ערב חג', name:'ערב שבועות'},
    '2026-05-22': {type:'חג', name:'שבועות'},
    '2026-07-22': {type:'ערב חג', name:'ערב תשעה באב'},
    '2026-07-23': {type:'חג', name:'תשעה באב'},
    '2026-09-11': {type:'ערב חג', name:'ערב ראש השנה'},
    '2026-09-12': {type:'חג', name:'ראש השנה א׳'},
    '2026-09-13': {type:'חג', name:'ראש השנה ב׳'},
    '2026-09-20': {type:'ערב חג', name:'ערב יום כיפור'},
    '2026-09-21': {type:'חג', name:'יום כיפור'},
    '2026-09-25': {type:'ערב חג', name:'ערב סוכות'},
    '2026-09-26': {type:'חג', name:'סוכות'},
    '2026-09-27': {type:'חג', name:'חוה״מ סוכות'},
    '2026-09-28': {type:'חג', name:'חוה״מ סוכות'},
    '2026-09-29': {type:'חג', name:'חוה״מ סוכות'},
    '2026-09-30': {type:'חג', name:'חוה״מ סוכות'},
    '2026-10-01': {type:'חג', name:'חוה״מ סוכות'},
    '2026-10-02': {type:'ערב חג', name:'הושענא רבה'},
    '2026-10-03': {type:'חג', name:'שמחת תורה'},
    '2026-12-05': {type:'חג', name:'חנוכה א׳'},
    '2026-12-06': {type:'חג', name:'חנוכה ב׳'},
    '2026-12-07': {type:'חג', name:'חנוכה ג׳'},
    '2026-12-08': {type:'חג', name:'חנוכה ד׳'},
    '2026-12-09': {type:'חג', name:'חנוכה ה׳'},
    '2026-12-10': {type:'חג', name:'חנוכה ו׳'},
    '2026-12-11': {type:'חג', name:'חנוכה ז׳'},
    '2026-12-12': {type:'חג', name:'חנוכה ח׳'},
  };
}

// ===== פונקציה אוניברסלית - צור לוח לכל חודש עם חגים =====
function initMonthSchedule(year, month) {
  // month: 1-12
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const monthStr = String(year) + String(month).padStart(2,'0');
  const sheetName = 'Schedule_' + monthStr;
  const existing = ss.getSheetByName(sheetName);
  if (existing) ss.deleteSheet(existing);
  const sheet = ss.insertSheet(sheetName);
  sheet.setRightToLeft(true);

  const headers = ['תאריך','יום','סוג יום','מבצע','עתודה א','עתודה ב','הערות','סוג תורנות','ניקוד','מבצע שני','עתודה א שנייה','עתודה ב שנייה'];
  sheet.getRange(1,1,1,headers.length).setValues([headers]);

  const HEB_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const holidays = getIsraeliHolidays2026();
  const daysInMonth = new Date(year, month, 0).getDate();
  const dutyScores = {
    'חול':10,'חמישי':12,'חמישי 24 שעות':16,'חול 24 שעות':15,
    'סוף שבוע':20,'סוף שבוע מלא':40,'ערב חג':25,'חג':25,'יומיים חג':50
  };

  const rows = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month-1, d);
    const dow = date.getDay(); // 0=Sun
    const dateStr = Utilities.formatDate(date, 'Asia/Jerusalem', 'yyyy-MM-dd');
    const holiday = holidays[dateStr];

    let dayType;
    if (holiday) {
      dayType = holiday.type; // 'חג' or 'ערב חג'
    } else if (dow === 5) {
      dayType = 'סוף שבוע';   // שישי
    } else if (dow === 6) {
      dayType = 'סוף שבוע';   // שבת
    } else if (dow === 4) {
      dayType = 'חמישי';      // חמישי
    } else {
      dayType = 'חול';        // חול
    }

    const notes = holiday ? holiday.name : '';

    rows.push([
      Utilities.formatDate(date, 'Asia/Jerusalem', 'dd/MM/yyyy'),
      HEB_DAYS[dow], dayType,
      '', '', '', notes, dayType, dutyScores[dayType] || 10
    ]);
  }

  sheet.getRange(2,1,rows.length,headers.length).setValues(rows);
  const monthNames = ['','ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  Logger.log('✅ לוח ' + monthNames[month] + ' ' + year + ' נוצר עם ' + daysInMonth + ' ימים + חגים!');
  return 'לוח ' + monthNames[month] + ' ' + year + ' מוכן!';
}

// קיצורי דרך לכל חודש 2026
function initJuly2026()     { return initMonthSchedule(2026, 7); }
function initAugust2026()   { return initMonthSchedule(2026, 8); }
function initSept2026()     { return initMonthSchedule(2026, 9); }
function initOct2026()      { return initMonthSchedule(2026, 10); }
function initNov2026()      { return initMonthSchedule(2026, 11); }
function initDec2026()      { return initMonthSchedule(2026, 12); }

function actionInitMonth(req) {
  const year = parseInt(req.year);
  const month = parseInt(req.month);
  if (!year || !month) return {success:false, error:'חסרים year ו-month'};
  try {
    const msg = initMonthScheduleEx(year, month);
    // A newly created month starts as a DRAFT — hidden from tornim until published
    const monthKey = String(year) + String(month).padStart(2, '0');
    setScheduleStatus(monthKey, 'draft');
    return {success:true, message: msg};
  } catch(e) {
    return {success:false, error: e.toString()};
  }
}

// ===== לוח חגים 2027-2029 =====
function getIsraeliHolidays() {
  const h2026 = getIsraeliHolidays2026();
  const h2027 = {
    '2027-03-22': {type:'ערב חג', name:'תענית אסתר'},
    '2027-03-23': {type:'חג', name:'פורים'},
    '2027-04-21': {type:'ערב חג', name:'ערב פסח'},
    '2027-04-22': {type:'חג', name:'פסח א׳'},
    '2027-04-23': {type:'חג', name:'חוה״מ פסח'},
    '2027-04-24': {type:'חג', name:'חוה״מ פסח'},
    '2027-04-25': {type:'חג', name:'חוה״מ פסח'},
    '2027-04-26': {type:'חג', name:'חוה״מ פסח'},
    '2027-04-27': {type:'ערב חג', name:'ערב שביעי של פסח'},
    '2027-04-28': {type:'חג', name:'שביעי של פסח'},
    '2027-05-10': {type:'ערב חג', name:'יום הזיכרון'},
    '2027-05-11': {type:'חג', name:'יום העצמאות'},
    '2027-06-10': {type:'ערב חג', name:'ערב שבועות'},
    '2027-06-11': {type:'חג', name:'שבועות'},
    '2027-08-11': {type:'ערב חג', name:'ערב תשעה באב'},
    '2027-08-12': {type:'חג', name:'תשעה באב'},
    '2027-10-01': {type:'ערב חג', name:'ערב ראש השנה'},
    '2027-10-02': {type:'חג', name:'ראש השנה א׳'},
    '2027-10-03': {type:'חג', name:'ראש השנה ב׳'},
    '2027-10-10': {type:'ערב חג', name:'ערב יום כיפור'},
    '2027-10-11': {type:'חג', name:'יום כיפור'},
    '2027-10-15': {type:'ערב חג', name:'ערב סוכות'},
    '2027-10-16': {type:'חג', name:'סוכות'},
    '2027-10-17': {type:'חג', name:'חוה״מ סוכות'},
    '2027-10-18': {type:'חג', name:'חוה״מ סוכות'},
    '2027-10-19': {type:'חג', name:'חוה״מ סוכות'},
    '2027-10-20': {type:'חג', name:'חוה״מ סוכות'},
    '2027-10-21': {type:'חג', name:'חוה״מ סוכות'},
    '2027-10-22': {type:'ערב חג', name:'הושענא רבה'},
    '2027-10-23': {type:'חג', name:'שמחת תורה'},
    '2027-12-25': {type:'חג', name:'חנוכה א׳'},
    '2027-12-26': {type:'חג', name:'חנוכה ב׳'},
    '2027-12-27': {type:'חג', name:'חנוכה ג׳'},
    '2027-12-28': {type:'חג', name:'חנוכה ד׳'},
    '2027-12-29': {type:'חג', name:'חנוכה ה׳'},
    '2027-12-30': {type:'חג', name:'חנוכה ו׳'},
    '2027-12-31': {type:'חג', name:'חנוכה ז׳'},
    '2028-01-01': {type:'חג', name:'חנוכה ח׳'},
  };
  const h2028 = {
    '2028-03-11': {type:'ערב חג', name:'תענית אסתר'},
    '2028-03-12': {type:'חג', name:'פורים'},
    '2028-04-10': {type:'ערב חג', name:'ערב פסח'},
    '2028-04-11': {type:'חג', name:'פסח א׳'},
    '2028-04-12': {type:'חג', name:'חוה״מ פסח'},
    '2028-04-13': {type:'חג', name:'חוה״מ פסח'},
    '2028-04-14': {type:'חג', name:'חוה״מ פסח'},
    '2028-04-15': {type:'חג', name:'חוה״מ פסח'},
    '2028-04-16': {type:'ערב חג', name:'ערב שביעי של פסח'},
    '2028-04-17': {type:'חג', name:'שביעי של פסח'},
    '2028-04-30': {type:'ערב חג', name:'יום הזיכרון'},
    '2028-05-01': {type:'חג', name:'יום העצמאות'},
    '2028-05-30': {type:'ערב חג', name:'ערב שבועות'},
    '2028-05-31': {type:'חג', name:'שבועות'},
    '2028-07-31': {type:'ערב חג', name:'ערב תשעה באב'},
    '2028-08-01': {type:'חג', name:'תשעה באב'},
    '2028-09-20': {type:'ערב חג', name:'ערב ראש השנה'},
    '2028-09-21': {type:'חג', name:'ראש השנה א׳'},
    '2028-09-22': {type:'חג', name:'ראש השנה ב׳'},
    '2028-09-29': {type:'ערב חג', name:'ערב יום כיפור'},
    '2028-09-30': {type:'חג', name:'יום כיפור'},
    '2028-10-04': {type:'ערב חג', name:'ערב סוכות'},
    '2028-10-05': {type:'חג', name:'סוכות'},
    '2028-10-06': {type:'חג', name:'חוה״מ סוכות'},
    '2028-10-07': {type:'חג', name:'חוה״מ סוכות'},
    '2028-10-08': {type:'חג', name:'חוה״מ סוכות'},
    '2028-10-09': {type:'חג', name:'חוה״מ סוכות'},
    '2028-10-10': {type:'חג', name:'חוה״מ סוכות'},
    '2028-10-11': {type:'ערב חג', name:'הושענא רבה'},
    '2028-10-12': {type:'חג', name:'שמחת תורה'},
    '2028-12-13': {type:'חג', name:'חנוכה א׳'},
    '2028-12-14': {type:'חג', name:'חנוכה ב׳'},
    '2028-12-15': {type:'חג', name:'חנוכה ג׳'},
    '2028-12-16': {type:'חג', name:'חנוכה ד׳'},
    '2028-12-17': {type:'חג', name:'חנוכה ה׳'},
    '2028-12-18': {type:'חג', name:'חנוכה ו׳'},
    '2028-12-19': {type:'חג', name:'חנוכה ז׳'},
    '2028-12-20': {type:'חג', name:'חנוכה ח׳'},
  };
  const h2029 = {
    '2029-02-28': {type:'ערב חג', name:'תענית אסתר'},
    '2029-03-01': {type:'חג', name:'פורים'},
    '2029-03-30': {type:'ערב חג', name:'ערב פסח'},
    '2029-03-31': {type:'חג', name:'פסח א׳'},
    '2029-04-01': {type:'חג', name:'חוה״מ פסח'},
    '2029-04-02': {type:'חג', name:'חוה״מ פסח'},
    '2029-04-03': {type:'חג', name:'חוה״מ פסח'},
    '2029-04-04': {type:'חג', name:'חוה״מ פסח'},
    '2029-04-05': {type:'ערב חג', name:'ערב שביעי של פסח'},
    '2029-04-06': {type:'חג', name:'שביעי של פסח'},
    '2029-04-17': {type:'ערב חג', name:'יום הזיכרון'},
    '2029-04-18': {type:'חג', name:'יום העצמאות'},
    '2029-05-19': {type:'ערב חג', name:'ערב שבועות'},
    '2029-05-20': {type:'חג', name:'שבועות'},
    '2029-07-21': {type:'ערב חג', name:'ערב תשעה באב'},
    '2029-07-22': {type:'חג', name:'תשעה באב'},
    '2029-09-09': {type:'ערב חג', name:'ערב ראש השנה'},
    '2029-09-10': {type:'חג', name:'ראש השנה א׳'},
    '2029-09-11': {type:'חג', name:'ראש השנה ב׳'},
    '2029-09-18': {type:'ערב חג', name:'ערב יום כיפור'},
    '2029-09-19': {type:'חג', name:'יום כיפור'},
    '2029-09-23': {type:'ערב חג', name:'ערב סוכות'},
    '2029-09-24': {type:'חג', name:'סוכות'},
    '2029-09-25': {type:'חג', name:'חוה״מ סוכות'},
    '2029-09-26': {type:'חג', name:'חוה״מ סוכות'},
    '2029-09-27': {type:'חג', name:'חוה״מ סוכות'},
    '2029-09-28': {type:'חג', name:'חוה״מ סוכות'},
    '2029-09-29': {type:'חג', name:'חוה״מ סוכות'},
    '2029-09-30': {type:'ערב חג', name:'הושענא רבה'},
    '2029-10-01': {type:'חג', name:'שמחת תורה'},
    '2029-12-02': {type:'חג', name:'חנוכה א׳'},
    '2029-12-03': {type:'חג', name:'חנוכה ב׳'},
    '2029-12-04': {type:'חג', name:'חנוכה ג׳'},
    '2029-12-05': {type:'חג', name:'חנוכה ד׳'},
    '2029-12-06': {type:'חג', name:'חנוכה ה׳'},
    '2029-12-07': {type:'חג', name:'חנוכה ו׳'},
    '2029-12-08': {type:'חג', name:'חנוכה ז׳'},
    '2029-12-09': {type:'חג', name:'חנוכה ח׳'},
  };
  return Object.assign({}, h2026, h2027, h2028, h2029);
}

// Update initMonthSchedule to use all-years holiday map
function initMonthScheduleEx(year, month) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const monthStr = String(year) + String(month).padStart(2,'0');
  const sheetName = 'Schedule_' + monthStr;
  const existing = ss.getSheetByName(sheetName);
  if (existing) ss.deleteSheet(existing);
  const sheet = ss.insertSheet(sheetName);
  sheet.setRightToLeft(true);

  const headers = ['תאריך','יום','סוג יום','מבצע','עתודה א','עתודה ב','הערות','סוג תורנות','ניקוד','מבצע שני','עתודה א שנייה','עתודה ב שנייה'];
  sheet.getRange(1,1,1,headers.length).setValues([headers]);

  const HEB_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const holidays = getIsraeliHolidays();
  const daysInMonth = new Date(year, month, 0).getDate();
  const dutyScores = {
    'חול':10,'חמישי':12,'חמישי 24 שעות':16,'חול 24 שעות':15,
    'סוף שבוע':20,'ערב חג':25,'חג':25
  };

  const rows = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month-1, d);
    const dow = date.getDay();
    const dateStr = Utilities.formatDate(date, 'Asia/Jerusalem', 'yyyy-MM-dd');
    const holiday = holidays[dateStr];
    let dayType = holiday ? holiday.type : (dow===5||dow===6) ? 'סוף שבוע' : dow===4 ? 'חמישי' : 'חול';
    const notes = holiday ? holiday.name : '';
    rows.push([
      Utilities.formatDate(date,'Asia/Jerusalem','dd/MM/yyyy'),
      HEB_DAYS[dow], dayType, '', '', '', notes, dayType, dutyScores[dayType]||10,
      '', '', ''
    ]);
  }
  sheet.getRange(2,1,rows.length,headers.length).setValues(rows);
  const monthNames = ['','ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  return 'לוח ' + monthNames[month] + ' ' + year + ' מוכן!';
}

// ===== Reset schedule =====
function actionResetSchedule(req) {
  try {
    const month = String(req.month || '').trim();
    const year = parseInt(req.year || month.substring(0,4));
    const mon  = parseInt(req.mon  || month.substring(4,6));
    if (!year || !mon) return {success:false, error:'חסר חודש'};
    const yearBlock = guardScoreYear(String(year) + String(mon).padStart(2,'0'));
    if (yearBlock) return yearBlock;
    // Clear sheet cache so next read gets fresh data
    _sheetCache = {};
    const msg = initMonthScheduleEx(year, mon);
    
    // Also clear this month's scores from Scores sheet
    var monColType  = 4 + (mon-1)*2 + 1; // col index (1-based): E=5 for jan
    var monColScore = monColType + 1;
    var scoreSheet  = getScoresSheet(String(year));
    var lastScoreRow = scoreSheet.getLastRow();
    if (lastScoreRow > 1) {
      scoreSheet.getRange(2, monColType,  lastScoreRow-1, 1).clearContent();
      scoreSheet.getRange(2, monColScore, lastScoreRow-1, 1).clearContent();
      Logger.log('Cleared scores for month ' + mon + ' (cols ' + monColType + '-' + monColScore + ')');
    }
    
    return {success:true, message: (msg || 'הלוח אופס בהצלחה') + ' + ניקוד החודש נוקה'};
  } catch(e) {
    Logger.log('resetSchedule error: ' + e.toString());
    return {success:false, error: e.toString()};
  }
}

// Update actionInitMonth to use extended version
function actionInitMonthEx(req) {
  const year = parseInt(req.year);
  const month = parseInt(req.month);
  if (!year || !month) return {success:false, error:'חסרים פרמטרים'};
  try {
    const msg = initMonthScheduleEx(year, month);
    return {success:true, message: msg};
  } catch(e) {
    return {success:false, error: e.toString()};
  }
}

// ===== צור לוחות ינואר-מאי 2026 (חודשים היסטוריים) =====
function initJanToMay2026() {
  for (let m = 1; m <= 5; m++) {
    initMonthScheduleEx(2026, m);
    Logger.log('Created Schedule_2026' + String(m).padStart(2,'0'));
  }
  Logger.log('✅ נוצרו לוחות ינואר עד מאי 2026');
}

// ===== בדיקת ואיפוס סיסמאות =====
function debugCheckPasswords() {
  const sheet = getSheet(SH.USERS);
  const rows = sheet.getDataRange().getValues();
  Logger.log('=== רשימת משתמשים ===');
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][2]) continue;
    Logger.log(`שם: ${rows[i][1]} | יוזר: ${rows[i][2]} | האש: ${String(rows[i][3]).substring(0,10)}... | פעיל: ${rows[i][5]}`);
  }
  Logger.log('סה"כ: ' + (rows.length-1) + ' משתמשים');
}

function resetAllPasswords() {
  // מאפס את כולם ל-Tornut2026 חוץ מ-admin
  const sheet = getSheet(SH.USERS);
  const rows = sheet.getDataRange().getValues();
  const defaultHash = hashPass('Tornut2026');
  const adminHash = hashPass('admin123');
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][2]) continue;
    if (rows[i][2] === 'admin') {
      sheet.getRange(i+1, 4).setValue(adminHash);
    } else {
      sheet.getRange(i+1, 4).setValue(defaultHash);
    }
    count++;
  }
  Logger.log('✅ אופסו סיסמאות ל-' + count + ' משתמשים');
  return 'אופסו ' + count + ' סיסמאות';
}

function fixActiveFlag() {
  // וודא שכולם מסומנים כפעילים
  const sheet = getSheet(SH.USERS);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2]) sheet.getRange(i+1, 6).setValue(true);
  }
  Logger.log('✅ כל המשתמשים מסומנים כפעילים');
}

// ===== נעילת/פתיחת לוח אילוצים =====
// נשמר בגיליון Settings בפורמט: month -> locked/open
function getSettingsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Settings');
  if (!sh) {
    sh = ss.insertSheet('Settings');
    sh.setRightToLeft(true);
    sh.getRange(1,1,1,3).setValues([['חודש','סטטוס','עודכן']]);
  }
  return sh;
}

function actionGetLockStatus(req) {
  if (!req) return {success: false, error: 'חסר req'};
  const month = String(req.month || '');
  const sh = getSettingsSheet();
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === month) {
      return {success: true, locked: rows[i][1] !== 'open', month};
    }
  }
  // Default: locked
  return {success: true, locked: true, month};
}

function actionSetLockStatus(req) {
  if (!req) return {success: false, error: 'חסר req'};
  // Auth is handled by router (admin-only section)
  const month = String(req.month || '');
  const locked = req.locked !== 'false' && req.locked !== false;
  const sh = getSettingsSheet();
  const rows = sh.getDataRange().getValues();
  
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === month) {
      sh.getRange(i+1, 2).setValue(locked ? 'locked' : 'open');
      sh.getRange(i+1, 3).setValue(new Date().toISOString());
      return {success: true, locked, month};
    }
  }
  // New row
  sh.appendRow([month, locked ? 'locked' : 'open', new Date().toISOString()]);
  return {success: true, locked, month};
}

// ===== TORANI DUTY HISTORY =====
// Regular users may only view their own history; admins may view anyone's.
function actionGetToraniHistory(req, user) {
  var name = String(req.name || '').trim();
  if (!user || user.role !== 'admin') name = String((user && user.name) || '').trim();
  if (!name) return {success: false, error: 'חסר שם'};

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var TZ = ss.getSpreadsheetTimeZone();
  var entries = [];
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var shName = sheets[s].getName();
    if (!/^Schedule_\d{6}$/.test(shName)) continue;
    var sh = sheets[s];
    if (sh.getLastRow() < 2) continue;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
    for (var i = 0; i < rows.length; i++) {
      var isV  = String(rows[i][3] || '').trim() === name;
      var isV2 = String(rows[i][9] || '').trim() === name;
      if (!isV && !isV2) continue;
      var d = rows[i][0];
      var dateStr = d instanceof Date ? Utilities.formatDate(d, TZ, 'yyyy-MM-dd') : String(d || '');
      entries.push({
        date: dateStr,
        month: shName.substring(9),
        dayType: String(rows[i][2] || ''),
        dutyType: String(rows[i][7] || ''),
        score: Number(rows[i][8]) || 0,
        role: isV ? 'מבצע' : 'מבצע 2'
      });
    }
  }
  entries.sort(function(a, b){ return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); }); // newest first
  return {success: true, name: name, entries: entries};
}

// ===== AUDIT LOG: READ (admin only, routed behind role check) =====
function actionGetAuditLog(req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('AuditLog');
  if (!sh || sh.getLastRow() < 2) return {success: true, entries: []};
  const limit = Math.min(parseInt(req.limit) || 300, 1000);
  const lastRow = sh.getLastRow();
  const startRow = Math.max(2, lastRow - limit + 1);
  const rows = sh.getRange(startRow, 1, lastRow - startRow + 1, 4).getValues();
  const entries = [];
  for (let i = rows.length - 1; i >= 0; i--) { // newest first
    entries.push({
      ts: rows[i][0] instanceof Date ? rows[i][0].toISOString() : String(rows[i][0]||''),
      who: String(rows[i][1]||''),
      action: String(rows[i][2]||''),
      details: String(rows[i][3]||'')
    });
  }
  return {success: true, entries};
}

// ===== SCHEDULE DRAFT/PUBLISHED STATUS =====
function getScheduleStatus(month) {
  const sh = getSettingsSheet();
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === 'sched_' + month) return String(rows[i][1]) === 'draft' ? 'draft' : 'published';
  }
  return 'published'; // default: months without a record are published
}

function setScheduleStatus(month, status) {
  const sh = getSettingsSheet();
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === 'sched_' + month) {
      sh.getRange(i+1, 2).setValue(status);
      sh.getRange(i+1, 3).setValue(new Date().toISOString());
      return;
    }
  }
  sh.appendRow(['sched_' + month, status, new Date().toISOString()]);
}

function actionPublishSchedule(req, user) {
  const month = String(req.month || '').trim();
  if (!month) return {success:false, error:'חסר חודש'};
  const status = (req.status === 'draft') ? 'draft' : 'published';
  setScheduleStatus(month, status);
  if (status === 'published') {
    // Bell notification to all active tornim
    try {
      const monthName = MONTH_NAMES[parseInt(month.substring(4,6)) - 1] + ' ' + month.substring(0,4);
      const rows = getSheet(SH.PEOPLE).getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        const nm = String(rows[i][0] || '').trim();
        const act = String(rows[i][1] || '').trim();
        if (nm && act !== '0') addSwapNotification(nm, '🗓️ לוח ' + monthName + ' פורסם! היכנסו למערכת לצפייה.');
      }
    } catch(e) { Logger.log('publish notify error: ' + e); }
  }
  return {success:true, month, status};
}

// ===== EMAIL: REMINDER =====
function actionSendReminder(req) {
  const month = String(req.month || '');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Constraints_' + month);
  
  // Get all people with emails
  const people = actionGetPeople().people;
  const submitted = {};
  
  if (sheet) {
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0]) {
        const hasAny = rows[i].slice(1, 32).some(c => c === 'V' || c === 'X');
        if (hasAny) submitted[rows[i][0]] = true;
      }
    }
  }
  
  const monthNames = ['','ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const mon = parseInt(month.substring(4,6));
  const year = month.substring(0,4);
  const monthName = monthNames[mon] + ' ' + year;
  
  let sent = 0;
  people.filter(p => p.activity !== '0' && p.dutyCategory !== 'פטור' && p.email && !submitted[p.name])
    .forEach(p => {
      try {
        MailApp.sendEmail({
          to: p.email,
          subject: `תזכורת: הגשת אילוצים ל${monthName}`,
          htmlBody: `<div dir="rtl" style="font-family:Arial;padding:20px">
            <h3>שלום ${p.name},</h3>
            <p>טרם הגשת אילוצים לחודש <strong>${monthName}</strong>.</p>
            <p>נא להיכנס למערכת התורנויות ולסמן את הימים הרלוונטיים עד מועד הסגירה.</p>
            <a href="https://matlam.netlify.app" style="background:#2ea043;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:12px">כניסה למערכת</a>
          </div>`
        });
        sent++;
      } catch(e) { Logger.log('Error sending to ' + p.email + ': ' + e); }
    });
  
  return {success: true, sent};
}

// ===== EMAIL: MONTHLY SCHEDULE =====
function actionSendScheduleEmails(req) {
  const month = String(req.month || '');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName('Schedule_' + month);
  if (!schedSheet) return {success: false, error: 'אין לוח לחודש זה'};
  
  const rows = schedSheet.getDataRange().getValues();
  const HEB_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const monthNames = ['','ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const mon = parseInt(month.substring(4,6));
  const year = month.substring(0,4);
  const monthName = monthNames[mon] + ' ' + year;
  
  // Build schedule map per person
  const personSchedule = {};
  for (let i = 1; i < rows.length; i++) {
    const [date, day, dayType, v, a, b, notes, dutyType, score] = rows[i];
    [[v,'מבצע'],[a,'עתודה א׳'],[b,'עתודה ב׳']].forEach(([name, role]) => {
      if (!name) return;
      if (!personSchedule[name]) personSchedule[name] = [];
      personSchedule[name].push({date, day, dutyType, role, score});
    });
  }
  
  const people = actionGetPeople().people;
  let sent = 0;
  
  people.filter(p => p.email && personSchedule[p.name]).forEach(p => {
    const duties = personSchedule[p.name];
    const rows_html = duties.map(d => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee">${d.date}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${d.day}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${d.dutyType}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;color:${d.role==='מבצע'?'#1a7f37':'#0969da'}">${d.role}</td>
      </tr>`).join('');
    
    try {
      MailApp.sendEmail({
        to: p.email,
        subject: `לוח תורנויות — ${monthName}`,
        htmlBody: `<div dir="rtl" style="font-family:Arial;padding:20px;max-width:600px">
          <h3>שלום ${p.name},</h3>
          <p>להלן התורנויות שלך לחודש <strong>${monthName}</strong>:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <thead><tr style="background:#f0f0f0">
              <th style="padding:8px;text-align:right">תאריך</th>
              <th style="padding:8px;text-align:right">יום</th>
              <th style="padding:8px;text-align:right">סוג</th>
              <th style="padding:8px;text-align:right">תפקיד</th>
            </tr></thead>
            <tbody>${rows_html}</tbody>
          </table>
          <a href="https://matlam.netlify.app" style="background:#2ea043;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">כניסה למערכת</a>
        </div>`
      });
      sent++;
    } catch(e) { Logger.log('Error: ' + e); }
  });
  
  return {success: true, sent};
}

// ===== SWAP REQUESTS =====

function getSwapsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('SwapRequests');
  if (!sh) {
    sh = ss.insertSheet('SwapRequests');
    sh.setRightToLeft(true);
    sh.getRange(1,1,1,10).setValues([['ID','חודש','תאריך שלי','מבקש','עם מי','תאריך שלהם','הערה','סטטוס','נוצר','']]);
  }
  return sh;
}

function actionSubmitSwap(req, user) {
  const {month, date, theirDate, withWho, note, fromName, myCol, theirCol} = req;
  if (!date || !withWho || !theirDate) return {success:false, error:'חסרים פרטים'};
  const id = Utilities.getUuid().substring(0,8);
  // Store: col info for exact cell replacement (4=V, 5=A, 6=B)
  var fName = String(fromName || user.name || '').trim();
  var wWho  = String(withWho || '').trim();
  var myD   = String(date || '').trim();
  var thD   = String(theirDate || date || '').trim();
  getSwapsSheet().appendRow([
    id,
    String(month      || '').trim(),
    myD, fName, wWho, thD,
    String(note       || '').trim(),
    'pending_target',
    new Date().toISOString(),
    JSON.stringify({myCol: parseInt(myCol)||4, theirCol: parseInt(theirCol)||4})
  ]);
  // Notify target person by email
  notifySwapTarget(wWho, fName, myD, thD, String(note||'').trim());
  return {success:true, id};
}

function actionGetSwaps(req, user) {
  const rows = getSwapsSheet().getDataRange().getValues();
  const swaps = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0] || !String(rows[i][0]).trim()) continue;
    swaps.push({
      id:        String(rows[i][0]).trim(),
      month:     String(rows[i][1] || '').trim(),
      date:      String(rows[i][2] || '').trim(),
      fromName:  String(rows[i][3] || '').trim(),
      withWho:   String(rows[i][4] || '').trim(),
      theirDate: String(rows[i][5] || '').trim(),
      note:      String(rows[i][6] || '').trim(),
      status:    String(rows[i][7] || 'pending_target').trim()
    });
  }
  return {success:true, swaps};
}

function actionUpdateSwap(req, user) {
  const {id, status} = req;
  const sheet = getSwapsSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() !== String(id).trim()) continue;
    var TZ2 = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    function normDateVal(v) {
      if (!v) return '';
      if (v instanceof Date) return Utilities.formatDate(v, TZ2, 'dd/MM/yyyy');
      var s = String(v).trim();
      // yyyy-MM-dd
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { var p=s.split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }
      return s;
    }
    // Month: could be number or string like "202605" or Date
    var month = rows[i][1] instanceof Date ?
      Utilities.formatDate(rows[i][1], TZ2, 'yyyyMM') :
      String(rows[i][1]).trim();
    const date      = normDateVal(rows[i][2]);
    const fromName  = String(rows[i][3]).trim();
    const withWho   = String(rows[i][4]).trim();
    const theirDate = normDateVal(rows[i][5]);
    const curStatus = String(rows[i][7]).trim();

    // Authorization: non-admins may only respond as the target of the request
    if (user && user.role !== 'admin') {
      if (status !== 'target_approved' && status !== 'target_rejected') {
        return {success:false, error:'אין הרשאה לפעולה זו'};
      }
      if (String(user.name || '').trim() !== withWho) {
        return {success:false, error:'רק התורן המבוקש יכול לאשר או לדחות את הבקשה'};
      }
    }

    Logger.log('updateSwap: id='+id+' month='+month+' date='+date+' theirDate='+theirDate+
               ' from='+fromName+' to='+withWho+' status='+curStatus+'->'+status);

    // Target approved → pending_admin
    if (status === 'target_approved' && curStatus === 'pending_target') {
      sheet.getRange(i+1,8).setValue('pending_admin');
      var fName2 = String(rows[i][3]).trim();
      var wWho2  = String(rows[i][4]).trim();
      var myD2   = String(rows[i][2]).trim();
      var thD2   = String(rows[i][5]).trim();
      // Notify admin
      notifyAdminSwapPending(fName2, wWho2, myD2, thD2);
      // Notify fromName that target approved
      var tz2 = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
      function normD(v) { return v instanceof Date ? Utilities.formatDate(v,tz2,'dd/MM/yyyy') : String(v||'').trim(); }
      addSwapNotification(fName2, '✅ ' + wWho2 + ' אישר את בקשת ההחלפה שלך (' + normD(myD2) + ' ⇄ ' + normD(thD2) + '). ממתין לאישור מנהל.');
      return {success:true, message:'עבר למנהל לאישור'};
    }
    // Target rejected
    if (status === 'target_rejected') {
      sheet.getRange(i+1,8).setValue('rejected');
      var fName3 = String(rows[i][3]).trim();
      var wWho3  = String(rows[i][4]).trim();
      var myD3   = String(rows[i][2]).trim();
      // Notify fromName that target rejected
      var tz3 = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
      function normD3(v) { return v instanceof Date ? Utilities.formatDate(v,tz3,'dd/MM/yyyy') : String(v||'').trim(); }
      addSwapNotification(fName3, '❌ ' + wWho3 + ' דחה את בקשת ההחלפה שלך (' + normD3(myD3) + ').');
      return {success:true};
    }
    // Admin approved → execute swap
    if (status === 'approved') {
      sheet.getRange(i+1,8).setValue('approved');
      var colInfo = {};
      try { colInfo = JSON.parse(String(rows[i][9]||'{}')); } catch(e) {}
      var result = executeSwap(month, date, fromName, withWho, theirDate || date, colInfo.myCol||0, colInfo.theirCol||0);
      if (!result.success) {
        sheet.getRange(i+1,10).setValue('שגיאה: ' + result.error);
        return {success:true, warning: result.error};
      }
      return {success:true, message:'ההחלפה בוצעה בלוח'};
    }
    // Admin rejected
    if (status === 'rejected') {
      sheet.getRange(i+1,8).setValue('rejected');
      // Notify both parties
      var tz5 = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
      function normD5(v) { return v instanceof Date ? Utilities.formatDate(v,tz5,'dd/MM/yyyy') : String(v||'').trim(); }
      addSwapNotification(fromName, '❌ המנהל דחה את בקשת ההחלפה (' + normD5(date) + ' ⇄ ' + normD5(theirDate||date) + ').');
      addSwapNotification(withWho, '❌ בקשת ההחלפה עם ' + fromName + ' נדחתה על ידי המנהל.');
      return {success:true};
    }
    // Unknown status — reject instead of writing blindly
    return {success:false, error:'סטטוס לא חוקי: ' + String(status)};
  }
  return {success:false, error:'בקשה לא נמצאה'};
}

function actionDeleteSwap(req) {
  const {id} = req;
  const sheet = getSwapsSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(id).trim()) {
      sheet.deleteRow(i+1);
      return {success:true};
    }
  }
  return {success:false, error:'לא נמצא'};
}

function actionReApplySwap(req) {
  const {id} = req;
  const sheet = getSwapsSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() !== String(id).trim()) continue;
    var colInfo2 = {};
    try { colInfo2 = JSON.parse(String(rows[i][9]||'{}')); } catch(e) {}
    var result = executeSwap(
      String(rows[i][1]).trim(),
      String(rows[i][2]).trim(),
      String(rows[i][3]).trim(),
      String(rows[i][4]).trim(),
      String(rows[i][5] || rows[i][2]).trim(),
      colInfo2.myCol||0, colInfo2.theirCol||0
    );
    if (result.success) sheet.getRange(i+1,8).setValue('approved');
    return result;
  }
  return {success:false, error:'לא נמצא'};
}

// ─── CORE EXECUTE SWAP ────────────────────────────────────
function executeSwap(month, myDate, fromName, withWho, theirDate, myCol, theirCol) {
  // myCol/theirCol: 4=V, 5=A, 6=B - which slot each person holds
  myCol    = parseInt(myCol)    || 0; // 0 = auto-detect
  theirCol = parseInt(theirCol) || 0;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var monthStr = String(month).trim();
  var sheet = ss.getSheetByName('Schedule_' + monthStr);
  if (!sheet) return {success:false, error:'לא נמצא לוח לחודש ' + monthStr};

  var TZ = ss.getSpreadsheetTimeZone();
  var data = sheet.getDataRange().getValues();

  function norm(val) {
    if (!val) return '';
    if (Object.prototype.toString.call(val) === '[object Date]')
      return Utilities.formatDate(val, TZ, 'dd/MM/yyyy');
    var s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { var p=s.split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }
    return s;
  }

  var myDateN    = norm(myDate);
  var theirDateN = norm(theirDate || myDate);
  var fromTrim   = String(fromName).trim();
  var withTrim   = String(withWho).trim();

  Logger.log('executeSwap: my='+myDateN+'(col'+myCol+') their='+theirDateN+'(col'+theirCol+') '+fromTrim+' <-> '+withTrim);

  var myRowIdx=-1, theirRowIdx=-1;
  for (var i=1; i<data.length; i++) {
    var rd = norm(data[i][0]);
    if (rd === myDateN)    myRowIdx    = i;
    if (rd === theirDateN) theirRowIdx = i;
  }

  Logger.log('myRow='+myRowIdx+' theirRow='+theirRowIdx);
  if (myRowIdx<0)    return {success:false, error:'לא נמצא תאריך ' + myDateN + ' בלוח ' + monthStr};
  if (theirRowIdx<0) return {success:false, error:'לא נמצא תאריך ' + theirDateN + ' בלוח ' + monthStr};

  // --- Replace fromName with withWho on myRow ---
  var myV=String(data[myRowIdx][3]||'').trim();
  var myA=String(data[myRowIdx][4]||'').trim();
  var myB=String(data[myRowIdx][5]||'').trim();
  var myScore=Number(data[myRowIdx][8])||0;
  var myType=String(data[myRowIdx][7]||data[myRowIdx][2]||'');

  var newMyV=myV, newMyA=myA, newMyB=myB;
  if (myCol===4 && myV===fromTrim) newMyV=withTrim;
  else if (myCol===5 && myA===fromTrim) newMyA=withTrim;
  else if (myCol===6 && myB===fromTrim) newMyB=withTrim;
  else {
    // Auto-detect
    if (myV===fromTrim) newMyV=withTrim;
    else if (myA===fromTrim) newMyA=withTrim;
    else if (myB===fromTrim) newMyB=withTrim;
    else return {success:false, error:fromTrim+' לא נמצא ב-'+myDateN+' (V:'+myV+' A:'+myA+' B:'+myB+')'};
  }
  sheet.getRange(myRowIdx+1,4).setValue(newMyV);
  sheet.getRange(myRowIdx+1,5).setValue(newMyA);
  sheet.getRange(myRowIdx+1,6).setValue(newMyB);
  Logger.log('myRow: V:'+myV+'->'+newMyV+' A:'+myA+'->'+newMyA+' B:'+myB+'->'+newMyB);

  var changedMyV = (myV!==newMyV);
  if (changedMyV && myScore>0) updateScoreForSwap(myV, newMyV, monthStr, myScore, myType);

  // --- Replace withWho with fromName on theirRow (if different date) ---
  if (myRowIdx !== theirRowIdx) {
    var thV=String(data[theirRowIdx][3]||'').trim();
    var thA=String(data[theirRowIdx][4]||'').trim();
    var thB=String(data[theirRowIdx][5]||'').trim();
    var thScore=Number(data[theirRowIdx][8])||0;
    var thType=String(data[theirRowIdx][7]||data[theirRowIdx][2]||'');

    var newThV=thV, newThA=thA, newThB=thB;
    if (theirCol===4 && thV===withTrim) newThV=fromTrim;
    else if (theirCol===5 && thA===withTrim) newThA=fromTrim;
    else if (theirCol===6 && thB===withTrim) newThB=fromTrim;
    else {
      // Auto-detect
      if (thV===withTrim) newThV=fromTrim;
      else if (thA===withTrim) newThA=fromTrim;
      else if (thB===withTrim) newThB=fromTrim;
      else return {success:false, error:withTrim+' לא נמצא ב-'+theirDateN+' (V:'+thV+' A:'+thA+' B:'+thB+')'};
    }
    sheet.getRange(theirRowIdx+1,4).setValue(newThV);
    sheet.getRange(theirRowIdx+1,5).setValue(newThA);
    sheet.getRange(theirRowIdx+1,6).setValue(newThB);
    Logger.log('theirRow: V:'+thV+'->'+newThV+' A:'+thA+'->'+newThA+' B:'+thB+'->'+newThB);

    var changedThV = (thV!==newThV);
    if (changedThV && thScore>0) updateScoreForSwap(thV, newThV, monthStr, thScore, thType);
  }

  return {success:true, message:'ההחלפה בוצעה: '+fromTrim+' ⇄ '+withTrim};
}



// ===== צור את כל לוחות השנה 2026-2029 מראש =====
function initAllSchedules() {
  var years = [2026, 2027, 2028, 2029];
  var created = 0;
  
  years.forEach(function(year) {
    for (var month = 1; month <= 12; month++) {
      try {
        initMonthScheduleEx(year, month);
        created++;
        Logger.log('Created Schedule_' + year + String(month).padStart(2,'0'));
      } catch(e) {
        Logger.log('Error creating ' + year + '/' + month + ': ' + e);
      }
    }
  });
  
  Logger.log('✅ נוצרו ' + created + ' לוחות שנה (2026-2029) עם חגים מובנים!');
  return 'נוצרו ' + created + ' לוחות שנה!';
}

// ===== ניקוי חד-פעמי: מחיקת שלדים עתידיים ריקים שנוצרו לפני תיקון תאריכי החגים =====
// הרץ פעם אחת מעורך Apps Script. מוחק כל גיליון Schedule_YYYYMM שהוא גם (א) עתידי
// ביחס לתאריך האמיתי של הרצת הפונקציה, וגם (ב) ריק לגמרי (אין בו אף שיבוץ V/V2) —
// כלומר שלד שמעולם לא נעשה בו שימוש, מהבנייה המרוכזת המקורית (initAllSchedules
// ל-2026-2029, לפני התיקון מול Hebcal). חודשים עם שיבוצים אמיתיים לעולם לא נוגעים,
// גם אם הם "עתידיים" באיזשהו מובן. בטוח להריץ שוב — לא עושה כלום אם אין מה למחוק.
// אחרי הניקוי, actionGenerateScheduleV2 שומר אוטומטית שלד אחד תמיד מוכן חודש קדימה
// (נוסף אוגוסט 2026), תמיד עם נתוני getIsraeliHolidays() העדכניים ביותר.
function cleanupFutureEmptySkeletons() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var now = new Date();
  var curKey = Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyyMM');

  var deleted = [], kept = [];
  ss.getSheets().forEach(function(sh) {
    var m = sh.getName().match(/^Schedule_(\d{6})$/);
    if (!m) return;
    var key = m[1];
    if (key <= curKey) return; // לא עתידי — לעולם לא נוגעים

    var lastRow = sh.getLastRow();
    var hasData = false;
    if (lastRow > 1) {
      // עמודות D..J: מבצע, עתודה א, עתודה ב, הערות, סוג תורנות, ניקוד, מבצע שני
      var rows = sh.getRange(2, 4, lastRow - 1, 7).getValues();
      hasData = rows.some(function(r){ return String(r[0]||'').trim() || String(r[6]||'').trim(); });
    }
    if (hasData) { kept.push(sh.getName()); return; }

    var name = sh.getName();
    ss.deleteSheet(sh);
    deleted.push(name);
  });

  Logger.log('נמחקו ' + deleted.length + ' שלדים ריקים: ' + deleted.join(', '));
  if (kept.length) Logger.log('דולגו (יש בהם שיבוצים אמיתיים): ' + kept.join(', '));
  return 'נמחקו ' + deleted.length + ' שלדים עתידיים ריקים.' +
    (kept.length ? ' (' + kept.length + ' דולגו כי היה בהם שיבוץ: ' + kept.join(', ') + ')' : '');
}

// ===== צור לוחות שנה לשנה ספציפית =====
function initYear2026() {
  for (var m=1; m<=12; m++) initMonthScheduleEx(2026, m);
  Logger.log('✅ כל לוחות 2026 נוצרו');
}
function initYear2027() {
  for (var m=1; m<=12; m++) initMonthScheduleEx(2027, m);
  Logger.log('✅ כל לוחות 2027 נוצרו');
}
function initYear2028() {
  for (var m=1; m<=12; m++) initMonthScheduleEx(2028, m);
  Logger.log('✅ כל לוחות 2028 נוצרו');
}
function initYear2029() {
  for (var m=1; m<=12; m++) initMonthScheduleEx(2029, m);
  Logger.log('✅ כל לוחות 2029 נוצרו');
}

// ===== עדכון ניקוד =====
function updateScoreForSwap(oldV, newV, month, score, dutyType) {
  if (!oldV || !newV || score <= 0) return;
  oldV = String(oldV).trim();
  newV = String(newV).trim();
  if (oldV === newV) return; // same person, no change

  var scoreSheet = getScoresSheet(scoreYearOf(month));
  var rows = scoreSheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    var name = String(rows[i][0] || '').trim();
    if (name === oldV) {
      var cur = Number(rows[i][3]) || 0;
      scoreSheet.getRange(i+1, 4).setValue(Math.max(0, cur - score));
      Logger.log('Score -' + score + ' from ' + oldV + ' (was ' + cur + ')');
    }
    if (name === newV) {
      var cur2 = Number(rows[i][3]) || 0;
      scoreSheet.getRange(i+1, 4).setValue(cur2 + score);
      Logger.log('Score +' + score + ' to ' + newV + ' (was ' + cur2 + ')');
    }
  }
}

// ===== תיקון ניקוד תורן שני =====
function actionFixV2Score(req) {
  var {personName, month, score, dutyType} = req;
  if (!personName || !score) return {success:false, error:'חסרים פרמטרים'};
  
  var numScore = Number(score);
  if (!numScore && dutyType) {
    numScore = getDutyTypesMap()[dutyType] || 10;
  }
  
  var scoreSheet = getScoresSheet(scoreYearOf(month));
  var rows = scoreSheet.getDataRange().getValues();
  
  for (var i=1; i<rows.length; i++) {
    if (String(rows[i][0]||'').trim() === String(personName).trim()) {
      var cur = Number(rows[i][3])||0;
      var newVal = cur + numScore;
      scoreSheet.getRange(i+1, 4).setValue(newVal);
      Logger.log('fixV2Score: '+personName+' '+cur+' -> '+newVal);
      return {success:true, message: personName+' קיבל +'+numScore+' ניקוד (היה: '+cur+', עכשיו: '+newVal+')'};
    }
  }
  return {success:false, error: 'לא נמצא: '+personName};
}

// ===== תגמול / קנס ידני מעמוד הניקוד =====
// Free-form admin adjustment to any torani's total score (positive = bonus,
// negative = penalty). A reason is mandatory so the audit log always explains
// why the number moved — unlike fixV2Score, this isn't tied to a schedule cell
// or a duty type, so it writes straight to the running total (col D) for the
// current active year.
function actionAdjustScore(req) {
  var personName = String(req.personName || '').trim();
  var reason = String(req.reason || '').trim();
  var numScore = Number(req.score);

  if (!personName) return {success:false, error:'חסר שם תורן'};
  if (!reason) return {success:false, error:'חובה למלא סיבה/הערה'};
  if (!numScore) return {success:false, error:'יש להזין ניקוד שונה מאפס'};

  // Mirrors actionGetScores: an explicit ?year= targets that year's sheet
  // (so a bonus/penalty given while viewing a past/future year on the scores
  // page lands in the right Scores_YYYY tab), else the active year.
  var targetYear = /^\d{4}$/.test(String(req.year || '')) ? String(req.year) : getActiveScoreYear();
  var scoreSheet = getScoresSheet(targetYear);
  var rows = scoreSheet.getDataRange().getValues();

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === personName) {
      var cur = Number(rows[i][3]) || 0;
      var newVal = cur + numScore;
      scoreSheet.getRange(i+1, 4).setValue(newVal);
      var sign = numScore > 0 ? '+' : '';
      Logger.log('adjustScore: ' + personName + ' ' + cur + ' -> ' + newVal + ' (' + reason + ')');
      return {success:true, message: personName + ' קיבל ' + sign + numScore + ' ניקוד (היה: ' + cur + ', עכשיו: ' + newVal + ') | סיבה: ' + reason};
    }
  }
  return {success:false, error: 'לא נמצא תורן בשם: ' + personName};
}

// ===== סנכרון ניקוד - מחשב מחדש מכל הלוחות ומעדכן גיליון Scores =====
function syncAllScores() {
  // DISABLED. This rebuilds every monthly column purely from the Schedule sheets,
  // which destroys entries that live only in the scores sheet — exemptions (פטור)
  // and manual corrections have no schedule row to be recovered from. It is also
  // month-indexed with no year component, so under per-year sheets it would write
  // one year's numbers over another. Left in place only for reference.
  throw new Error('syncAllScores מושבתת: היא מוחקת פטורים ותיקונים ידניים, ואינה מודעת לשנים. אין להריץ אותה.');
  /* eslint-disable no-unreachable */
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var scoreSheet = getScoresSheet(getActiveScoreYear());
  var scoreRows = scoreSheet.getDataRange().getValues();
  var monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  var dutyScores = getDutyTypesMap();
  
  // Build per-person monthly scores from all schedule sheets
  var personScores = {}; // name -> {jan:0, feb:0, ...}
  
  ss.getSheets().forEach(function(sh) {
    if (!/^Schedule_\d{6}$/.test(sh.getName())) return;
    var mon = parseInt(sh.getName().substring(10,12)) - 1; // 0=jan
    var mKey = monthNames[mon];
    if (!mKey) return;
    
    var rows = sh.getLastRow() > 1 ? sh.getRange(1,1,sh.getLastRow(),12).getValues() : [];
    for (var i=1; i<rows.length; i++) {
      var v   = String(rows[i][3]||'').trim();
      var v2  = String(rows[i][9]||'').trim();
      var sc  = Number(rows[i][8])||0;
      
      if (v && sc>0) {
        if (!personScores[v]) personScores[v] = {};
        personScores[v][mKey] = (personScores[v][mKey]||0) + sc;
      }
      if (v2 && sc>0) {
        if (!personScores[v2]) personScores[v2] = {};
        personScores[v2][mKey] = (personScores[v2][mKey]||0) + sc;
      }
    }
  });
  
  // Update Scores sheet
  // Col layout: A=שם, B=פעילות, C=acc2025, D=acc2026(sum of months), E=ינואר סוג, F=ינואר ניקוד, G=פברואר סוג...
  var updated = 0;
  for (var i=1; i<scoreRows.length; i++) {
    var name = String(scoreRows[i][0]||'').trim();
    if (!name) continue;
    // Skip admin
    var pData = getSheet(SH.PEOPLE).getDataRange().getValues();
    var isAdmin = false;
    for (var pi=1;pi<pData.length;pi++) {
      if (String(pData[pi][0]||'').trim()===name && String(pData[pi][2]||'').trim()==='מנהל מערכת') {isAdmin=true;break;}
    }
    if (isAdmin) continue;
    var ps = personScores[name] || {};
    var acc2025 = Number(scoreRows[i][2])||0;
    var total2026 = 0;
    monthNames.forEach(function(mKey, idx) {
      var sc = ps[mKey]||0;
      total2026 += sc;
      var scoreCol = 4 + idx*2 + 2; // col F=6 (jan), H=8 (feb)...
      scoreSheet.getRange(i+1, scoreCol).setValue(sc>0 ? sc : '');
    });
    // acc2026 column = total cumulative (2025 + all 2026 months)
    scoreSheet.getRange(i+1, 4).setValue(acc2025 + total2026);
    updated++;
  }
  
  Logger.log('✅ syncAllScores: עודכנו '+updated+' תורנים');
  SpreadsheetApp.getUi().alert('✅ הניקוד עודכן עבור '+updated+' תורנים');
}

// ===== מערכת אימיילים =====

// כתובת מייל של מנהל
var ADMIN_EMAIL = 'itai.rosenblum@example.com'; // שנה לכתובת המייל שלך

// קבל מייל של תורן לפי שם
function getEmailByName(name) {
  var rows = getSheet(SH.PEOPLE).getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]||'').trim() === String(name).trim()) {
      return String(rows[i][5]||'').trim(); // עמודה F = מייל
    }
  }
  return '';
}

// קבל מייל של כל התורנים הפעילים
function getAllActiveEmails() {
  var rows = getSheet(SH.PEOPLE).getDataRange().getValues();
  var emails = [];
  for (var i = 1; i < rows.length; i++) {
    var email = String(rows[i][5]||'').trim();
    var activity = String(rows[i][1]||'1').trim();
    if (email && activity !== '0') emails.push(email);
  }
  return emails;
}

// 1. שלח לוח תורנויות לכולם
function actionSendSchedule(req) {
  var {month, extraMessage} = req;
  var monthStr = String(month||'').trim();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Schedule_' + monthStr);
  if (!sheet) return {success:false, error:'לא נמצא לוח לחודש ' + monthStr};
  
  var TZ = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(1,1,sheet.getLastRow(),12).getValues() : [];
  
  // Build schedule HTML table
  var year = monthStr.substring(0,4);
  var mon  = parseInt(monthStr.substring(4,6));
  var MONTH_NAMES = ['','ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  var title = MONTH_NAMES[mon] + ' ' + year;
  
  var tableRows = '';
  for (var i = 1; i < rows.length; i++) {
    var dateCell = rows[i][0];
    var dateStr = dateCell instanceof Date ? Utilities.formatDate(dateCell, TZ, 'dd/MM') : String(dateCell||'');
    var day = String(rows[i][1]||'');
    var dayType = String(rows[i][2]||'');
    var v = String(rows[i][3]||'');
    var a = String(rows[i][4]||'');
    var b = String(rows[i][5]||'');
    var v2 = String(rows[i][9]||'');
    if (!v && !a && !b) continue;
    
    var bgColor = dayType.includes('חג')||dayType.includes('ערב חג') ? '#fff3cd' :
                  dayType === 'סוף שבוע'||dayType === 'סוף שבוע מלא' ? '#f0f0ff' :
                  dayType === 'חמישי'||dayType.includes('חמישי') ? '#fff8e6' : '#ffffff';
    
    tableRows += '<tr style="background:' + bgColor + '">' +
      '<td style="padding:6px 10px;border:1px solid #ddd;font-weight:bold">' + dateStr + ' ' + day + '</td>' +
      '<td style="padding:6px 10px;border:1px solid #ddd;color:#666;font-size:12px">' + dayType + '</td>' +
      '<td style="padding:6px 10px;border:1px solid #ddd;font-weight:600">' + v + '</td>' +
      '<td style="padding:6px 10px;border:1px solid #ddd;color:#555">' + a + '</td>' +
      '<td style="padding:6px 10px;border:1px solid #ddd;color:#555">' + b + '</td>' +
      (v2 ? '<td style="padding:6px 10px;border:1px solid #ddd;color:#888;font-size:11px">+' + v2 + '</td>' : '<td></td>') +
      '</tr>';
  }
  
  var html = '<div dir="rtl" style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">' +
    '<h2 style="color:#2d4a3e">📅 לוח תורנויות — ' + title + '</h2>' +
    (extraMessage ? '<div style="background:#e8f5e9;border-right:4px solid #4caf50;padding:12px 16px;margin-bottom:16px;border-radius:4px">' + extraMessage + '</div>' : '') +
    '<table style="width:100%;border-collapse:collapse;direction:rtl">' +
    '<thead><tr style="background:#2d4a3e;color:white">' +
    '<th style="padding:8px 10px;border:1px solid #ddd">תאריך</th>' +
    '<th style="padding:8px 10px;border:1px solid #ddd">סוג</th>' +
    '<th style="padding:8px 10px;border:1px solid #ddd">מבצע</th>' +
    '<th style="padding:8px 10px;border:1px solid #ddd">עתודה א׳</th>' +
    '<th style="padding:8px 10px;border:1px solid #ddd">עתודה ב׳</th>' +
    '<th style="padding:8px 10px;border:1px solid #ddd">תורנות שנייה</th>' +
    '</tr></thead><tbody>' + tableRows + '</tbody></table>' +
    '<p style="color:#999;font-size:11px;margin-top:16px">מפקד תורן מטל"מ</p></div>';
  
  var emails = getAllActiveEmails();
  var sent = 0;
  emails.forEach(function(email) {
    try {
      MailApp.sendEmail({
        to: email,
        subject: '📅 לוח תורנויות ' + title,
        htmlBody: html
      });
      sent++;
    } catch(e) { Logger.log('Failed to send to ' + email + ': ' + e); }
  });
  
  return {success:true, message:'נשלח ל-' + sent + ' תורנים מתוך ' + emails.length};
}

// 2. שלח הודעה חשובה (מנהל)
function actionSendAdminMessage(req) {
  var {subject, message, recipients} = req;
  if (!message || !subject) return {success:false, error:'חסרים פרטים'};
  
  var emails = recipients === 'all' ? getAllActiveEmails() : [recipients];
  
  var html = '<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<h2 style="color:#2d4a3e">📣 ' + subject + '</h2>' +
    '<div style="background:#f9f9f9;border-right:4px solid #2d4a3e;padding:16px;border-radius:4px;line-height:1.6">' + 
    message.replace(/\n/g,'<br>') + '</div>' +
    '<p style="color:#999;font-size:11px;margin-top:16px">מפקד תורן מטל"מ</p></div>';
  
  var sent = 0;
  emails.forEach(function(email) {
    try {
      MailApp.sendEmail({to: email, subject: '📣 ' + subject, htmlBody: html});
      sent++;
    } catch(e) { Logger.log('Failed: ' + e); }
  });
  
  return {success:true, message:'נשלח ל-' + sent + ' נמענים'};
}

// 3. שלח מייל לתורן שמבקשים להחליף איתו
function notifySwapTarget(withWho, fromName, date, theirDate, note) {
  var email = getEmailByName(withWho);
  if (!email) { Logger.log('No email for ' + withWho); return; }
  
  var html = '<div dir="rtl" style="font-family:Arial,sans-serif;max-width:500px">' +
    '<h3 style="color:#2d4a3e">🔄 בקשת החלפת תורנות</h3>' +
    '<p><strong>' + fromName + '</strong> מבקש להחליף איתך תורנות:</p>' +
    '<table style="border-collapse:collapse;width:100%">' +
    '<tr><td style="padding:8px;background:#f5f5f5;border:1px solid #ddd">📅 תורנות של ' + fromName + ':</td><td style="padding:8px;border:1px solid #ddd">' + date + '</td></tr>' +
    '<tr><td style="padding:8px;background:#f5f5f5;border:1px solid #ddd">📅 תורנות שלך:</td><td style="padding:8px;border:1px solid #ddd">' + theirDate + '</td></tr>' +
    (note ? '<tr><td style="padding:8px;background:#f5f5f5;border:1px solid #ddd">💬 הסבר:</td><td style="padding:8px;border:1px solid #ddd">' + note + '</td></tr>' : '') +
    '</table>' +
    '<p style="margin-top:16px">היכנס למערכת כדי לאשר או לדחות את הבקשה.</p>' +
    '<p style="color:#999;font-size:11px">מפקד תורן מטל"מ</p></div>';
  
  try {
    MailApp.sendEmail({to: email, subject: '🔄 בקשת החלפה מ-' + fromName, htmlBody: html});
    Logger.log('Swap notification sent to ' + withWho + ' (' + email + ')');
  } catch(e) { Logger.log('Failed to notify swap target: ' + e); }
}

// 4. שלח מייל למנהל כשהחלפה ממתינה לאישורו
function notifyAdminSwapPending(fromName, withWho, date, theirDate) {
  var adminEmail = getAdminEmail();
  if (!adminEmail) return;
  
  var html = '<div dir="rtl" style="font-family:Arial,sans-serif;max-width:500px">' +
    '<h3 style="color:#2d4a3e">⏳ בקשת החלפה ממתינה לאישורך</h3>' +
    '<p><strong>' + fromName + '</strong> ו-<strong>' + withWho + '</strong> אישרו ביניהם החלפה:</p>' +
    '<table style="border-collapse:collapse;width:100%">' +
    '<tr><td style="padding:8px;background:#f5f5f5;border:1px solid #ddd">📅 תורנות ' + fromName + ':</td><td style="padding:8px;border:1px solid #ddd">' + date + '</td></tr>' +
    '<tr><td style="padding:8px;background:#f5f5f5;border:1px solid #ddd">📅 תורנות ' + withWho + ':</td><td style="padding:8px;border:1px solid #ddd">' + theirDate + '</td></tr>' +
    '</table>' +
    '<p style="margin-top:16px">היכנס למערכת לאישור.</p>' +
    '<p style="color:#999;font-size:11px">מפקד תורן מטל"מ</p></div>';
  
  try {
    MailApp.sendEmail({to: adminEmail, subject: '⏳ החלפת תורנות ממתינה לאישורך', htmlBody: html});
  } catch(e) { Logger.log('Failed to notify admin: ' + e); }
}

// קבל מייל מנהל מגיליון Users
function getAdminEmail() {
  // Strategy 1: Get admin name from Users, then email from People sheet
  var usersRows = getSheet(SH.USERS).getDataRange().getValues();
  var adminName = '';
  for (var i = 1; i < usersRows.length; i++) {
    if (String(usersRows[i][4]||'').trim() === 'admin') {
      adminName = String(usersRows[i][1]||'').trim();
      // Also check col 5 (F) directly in Users sheet
      var directEmail = String(usersRows[i][5]||'').trim();
      if (directEmail && directEmail.includes('@')) return directEmail;
      break;
    }
  }
  // Strategy 2: Look up in People sheet by name
  if (adminName) {
    var email = getEmailByName(adminName);
    if (email) return email;
  }
  // Strategy 3: Use the Google account running the script
  try {
    var scriptEmail = Session.getEffectiveUser().getEmail();
    if (scriptEmail) return scriptEmail;
  } catch(e) {}
  return '';
}

// ===== בדיקת מיילים - הרץ פעם אחת כדי לאשר הרשאות =====
function testEmailPermissions() {
  try {
    var myEmail = Session.getActiveUser().getEmail();
    MailApp.sendEmail({
      to: myEmail,
      subject: '✅ מפקד תורן מטל"מ - בדיקת מיילים',
      htmlBody: '<div dir="rtl"><h3>✅ מערכת המיילים פועלת!</h3><p>ההרשאות אושרו בהצלחה.</p></div>'
    });
    Logger.log('Test email sent to: ' + myEmail);
    return 'נשלח מייל בדיקה ל-' + myEmail;
  } catch(e) {
    Logger.log('Error: ' + e.toString());
    return 'שגיאה: ' + e.toString();
  }
}

// ===== DEBUG: בדוק login =====
function debugLogin() {
  var rows = getSheet(SH.USERS).getDataRange().getValues();
  Logger.log('Users sheet rows: ' + (rows.length-1));
  for (var i=1; i<rows.length && i<5; i++) {
    Logger.log('Row '+i+': id='+rows[i][0]+' name='+rows[i][1]+' user='+rows[i][2]+' role='+rows[i][4]+' active='+rows[i][5]);
    Logger.log('  pwd hash length: '+String(rows[i][3]||'').length);
  }
  // Test hash
  var testHash = hashPass('admin123');
  Logger.log('Hash of admin123: '+testHash);
  Logger.log('Hash of Tornut2026: '+hashPass('Tornut2026'));
}

// ===== איפוס סיסמה ידני (מנהל בלבד) =====
function actionResetPassword(req) {
  var {targetUsername, newPassword} = req;
  if (!targetUsername || !newPassword) return {success:false, error:'חסרים פרטים'};
  var sheet = getSheet(SH.USERS);
  var rows = sheet.getDataRange().getValues();
  for (var i=1; i<rows.length; i++) {
    if (String(rows[i][2]||'').toLowerCase() === String(targetUsername).toLowerCase()) {
      var newHash = hashPass(newPassword);
      sheet.getRange(i+1, 4).setValue(newHash);
      Logger.log('Password reset for: ' + targetUsername);
      return {success:true, message:'סיסמה אופסה עבור ' + targetUsername};
    }
  }
  return {success:false, error:'משתמש לא נמצא: ' + targetUsername};
}

// ===== איפוס סיסמת ברירת מחדל לכל התורנים =====
function resetAllTornimPasswords() {
  var sheet = getSheet(SH.USERS);
  var rows = sheet.getDataRange().getValues();
  var defaultPass = 'Aa123456';
  var newHash = hashPass(defaultPass);
  var count = 0;
  
  for (var i = 1; i < rows.length; i++) {
    var role = String(rows[i][4]||'').trim();
    var uname = String(rows[i][2]||'').trim();
    if (role !== 'admin' && uname) { // don't reset admin
      sheet.getRange(i+1, 4).setValue(newHash);
      count++;
      Logger.log('Reset password for: ' + uname);
    }
  }
  Logger.log('Done: reset ' + count + ' passwords to ' + defaultPass);
  return 'אופסו ' + count + ' סיסמאות לסיסמת ברירת מחדל: ' + defaultPass;
}

// ===== התראות החלפה =====
function addSwapNotification(toName, message) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Notifications');
    if (!sh) {
      sh = ss.insertSheet('Notifications');
      sh.getRange(1,1,1,4).setValues([['ID','ToName','Message','CreatedAt']]);
    }
    sh.appendRow([
      Utilities.getUuid().substring(0,8),
      String(toName).trim(),
      String(message).trim(),
      new Date().toISOString()
    ]);
  } catch(e) {
    Logger.log('addSwapNotification error: ' + e);
  }
}

// ===== קריאת התראות אישיות =====
function actionGetNotificationsPersonal(req, user) {
  var myName = String(user.name || '').trim();
  var notifs = [];
  
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Notifications');
    if (sh && sh.getLastRow() > 1) {
      var rows = sh.getRange(1, 1, sh.getLastRow(), 4).getValues();
      for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][1]||'').trim() === myName) {
          notifs.push({
            id: String(rows[i][0]).trim(),
            message: String(rows[i][2]||'').trim(),
            createdAt: String(rows[i][3]||'').trim(),
            rowIdx: i+1
          });
        }
      }
    }
  } catch(e) { Logger.log('getNotificationsPersonal error: ' + e); }
  
  return {success: true, notifications: notifs};
}

// ===== מחיקת התראות =====
// These were listed in viewerAllowed and called by the frontend, but never had a
// router entry or an implementation — every clear silently returned "פעולה לא מוכרת",
// the frontend swallowed it in an empty catch, and the rows stayed in the sheet, so
// the next poll brought the same notifications straight back.
// Deletion is scoped by name: a user can only ever delete their OWN rows.
function actionClearNotification(req, user) {
  var myName  = String((user && user.name) || '').trim();
  var notifId = String(req.notifId || '').trim();
  if (!myName)  return {success: false, error: 'חסר משתמש'};
  if (!notifId) return {success: false, error: 'חסר מזהה התראה'};
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Notifications');
    if (!sh || sh.getLastRow() < 2) return {success: true, deleted: 0};
    var rows = sh.getRange(1, 1, sh.getLastRow(), 4).getValues();
    // Walk bottom-up: deleting a row shifts everything below it up.
    for (var i = rows.length - 1; i >= 1; i--) {
      if (String(rows[i][0] || '').trim() === notifId &&
          String(rows[i][1] || '').trim() === myName) {
        sh.deleteRow(i + 1);
        return {success: true, deleted: 1};
      }
    }
    return {success: true, deleted: 0};
  } catch(e) {
    Logger.log('clearNotification error: ' + e);
    return {success: false, error: e.toString()};
  }
}

function actionClearAllNotifications(req, user) {
  var myName = String((user && user.name) || '').trim();
  if (!myName) return {success: false, error: 'חסר משתמש'};
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Notifications');
    if (!sh || sh.getLastRow() < 2) return {success: true, deleted: 0};
    var rows = sh.getRange(1, 1, sh.getLastRow(), 4).getValues();
    var deleted = 0;
    for (var i = rows.length - 1; i >= 1; i--) {
      if (String(rows[i][1] || '').trim() === myName) { sh.deleteRow(i + 1); deleted++; }
    }
    return {success: true, deleted: deleted};
  } catch(e) {
    Logger.log('clearAllNotifications error: ' + e);
    return {success: false, error: e.toString()};
  }
}

// ===== איפוס סיסמת ADMIN =====
function resetAdminPassword() {
  var sheet = getSheet(SH.USERS);
  var rows = sheet.getDataRange().getValues();
  var newHash = hashPass('admin123');
  var count = 0;
  
  for (var i = 1; i < rows.length; i++) {
    var role = String(rows[i][4]||'').trim();
    var uname = String(rows[i][2]||'').trim();
    if (role === 'admin' || uname === 'admin') {
      sheet.getRange(i+1, 4).setValue(newHash);
      count++;
      Logger.log('Reset admin password for: ' + uname);
    }
  }
  Logger.log('Done. Admin password reset to: admin123');
  return 'סיסמת admin אופסה ל: admin123 (' + count + ' שורות)';
}

// ===== קבלת שיבוץ מ-duty_agent.py =====
// ===================================================================
// DUTY AGENT ALGORITHM — translated from duty_agent.py
// ===================================================================

var DUTY_SCORES_MAP = {
  'חול':10, 'חמישי':12, 'סוף שבוע':20,
  'סוף שבוע מלא':40, 'ערב חג':30, 'חג':30,
  'חג + סוף שבוע':50, 'דולג':0, 'פטור':10,
  'חול 24 שעות':15, 'חמישי 24 שעות':16, 'הדממה':18
};

function actionGenerateScheduleV2(req) {
  var month = String(req.month || '').trim();
  var year  = parseInt(month.substring(0,4));
  var mon   = parseInt(month.substring(4,6));
  if (!year || !mon) return {success:false, error:'חסר חודש'};

  var yearBlock = guardScoreYear(month);
  if (yearBlock) return yearBlock;

  // Newly generated schedules start as draft — hidden from tornim until published
  setScheduleStatus(month, 'draft');

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var TZ  = ss.getSpreadsheetTimeZone();

  // ── 1. Load People & Scores ─────────────────────────────────────
  var peopleRows = ss.getSheetByName('People').getDataRange().getValues();
  var scoreRows  = getScoresSheet(String(year)).getDataRange().getValues();
  
  // Build people map: name → {activity, dutyCategory, weekendType}
  var peopleMap = {};
  for (var i = 1; i < peopleRows.length; i++) {
    var nm = String(peopleRows[i][0]||'').trim();
    if (nm) {
      peopleMap[nm] = {
        name:        nm,
        activity:    String(peopleRows[i][1]||'1').trim(),
        dutyCategory:String(peopleRows[i][2]||'').trim(),
        weekendType: String(peopleRows[i][4]||'מלא').trim(),
        endDate:     peopleRows[i][6] || null
      };
      // משרת אב is identified by CATEGORY in the UI — normalize to activity 0.5
      // so every paternity protection (Thursday-only, 2-month gap) applies.
      if (peopleMap[nm].dutyCategory === 'אב') peopleMap[nm].activity = '0.5';
    }
  }

  // Users sheet is the authority on who is active: a torani deactivated in the
  // tornim page must never be scheduled, regardless of the People activity column.
  var usersActive = {}, usersRole = {};
  try {
    var uRowsAct = ss.getSheetByName('Users').getDataRange().getValues();
    for (var ua = 1; ua < uRowsAct.length; ua++) {
      var uan = String(uRowsAct[ua][1]||'').trim();
      if (uan) {
        usersActive[uan] = !!uRowsAct[ua][5];
        usersRole[uan] = String(uRowsAct[ua][4]||'').trim();
      }
    }
  } catch(e) { Logger.log('users load: ' + e); }

  var monthStart = new Date(year, mon-1, 1);
  var excludedNames = {};
  Object.keys(peopleMap).forEach(function(exn){
    var pmx = peopleMap[exn];
    if (pmx.dutyCategory === 'מנהל מערכת') return;
    if (usersActive[exn] === false) { excludedNames[exn] = 'לא פעיל'; return; }
    if (usersRole[exn] === 'viewer') { excludedNames[exn] = 'צפייה בלבד'; return; }
    if (pmx.endDate) {
      var edd = (pmx.endDate instanceof Date) ? pmx.endDate : new Date(String(pmx.endDate));
      if (!isNaN(edd)) {
        if (edd < monthStart) { excludedNames[exn] = 'סיים שירות'; return; }
        pmx.endDateObj = edd; // ends mid-month: block days after the end date
      }
    }
  });

  // Build scores map + history
  var scores = {}, people = {};
  for (var j = 1; j < scoreRows.length; j++) {
    var sname = String(scoreRows[j][0]||'').trim();
    if (!sname) continue;
    // Skip admin - not a torni
    var pm_check = peopleMap[sname] || {};
    if (pm_check.dutyCategory === 'מנהל מערכת') continue;
    // Skip deactivated tornim and those whose service ended before this month
    if (excludedNames[sname]) continue;
    // IDEMPOTENT accumulated total: base-2025 (col C) + sum of monthly score columns
    // EXCLUDING the month being generated — so re-running never double-counts.
    var base2025 = Number(scoreRows[j][2])||0;
    var acc2026 = base2025;
    for (var accM = 1; accM <= 12; accM++) {
      if (accM === mon) continue;
      acc2026 += Number(scoreRows[j][5 + (accM-1)*2])||0; // 0-indexed monthly SCORE col (F=5 for jan)
    }
    var pm      = peopleMap[sname] || {name:sname,activity:'1',dutyCategory:'',weekendType:'מלא'};

    // Check last full-weekend, last weekend, and last duty of any kind from monthly columns
    // Scores sheet: col E(5)=ינואר סוג, F(6)=ינואר ניקוד, G(7)=פברואר סוג...
    var lastFW = null, lastWeekend = null, lastDuty = null;
    for (var back = 1; back <= 12; back++) {
      var mNum = mon - back;
      if (mNum < 1) break;
      var colIdx = 4 + (mNum-1)*2;
      var dtype = String(scoreRows[j][colIdx]||'').trim();
      if (!dtype) continue;
      if (lastDuty === null && dtype !== 'פטור' && dtype !== 'דולג') lastDuty = mNum;
      if (lastFW === null && dtype.indexOf('סוף שבוע מלא') !== -1) lastFW = mNum;
      if (lastWeekend === null && (dtype.indexOf('סוף שבוע') !== -1 || dtype.indexOf('שבת') !== -1))
        lastWeekend = mNum;
      if (lastFW !== null && lastWeekend !== null && lastDuty !== null) break;
    }
    
    // Check if prev month had חג
    var prevMonDuty = '';
    if (mon > 1) {
      var prevColIdx = 4 + (mon-2)*2;
      prevMonDuty = String(scoreRows[j][prevColIdx]||'').trim();
    }

    people[sname] = Object.assign({}, pm, {
      score_2026:   acc2026,
      last_fw:      lastFW,
      last_weekend: lastWeekend,
      prev_hag:     prevMonDuty.indexOf('חג') !== -1,
      last_duty:    lastDuty,
      no_skip:      false,
      duty_type:    pm.weekendType === 'מלא' ? 'סוף שבוע מלא' : null
    });
    scores[sname] = acc2026;
  }

  // ── 2. Load Constraints ──────────────────────────────────────────
  var cSheetName = 'Constraints_' + month;
  var calInfo = {}; // name → {constraints: Set, forced_v: Set, preference: str}
  var cSheet = ss.getSheetByName(cSheetName);
  if (cSheet) {
    var cRows = cSheet.getDataRange().getValues();
    var daysInMonth = new Date(year, mon, 0).getDate();
    for (var ci = 1; ci < cRows.length; ci++) {
      var cname = String(cRows[ci][0]||'').trim();
      if (!cname || !people[cname]) continue;
      var constraints = {}, forced_v = {};
      for (var d = 1; d <= daysInMonth; d++) {
        var cv = String(cRows[ci][d]||'').trim().toUpperCase();
        if (cv === 'X') constraints[d] = true;
        if (cv === 'V') forced_v[d] = true;
      }
      var pref = String(cRows[ci][daysInMonth+1]||'').trim();
      var noSkip = pref.indexOf('לא לדלג') !== -1 || pref.indexOf('ללא דילוג') !== -1;
      if (noSkip) people[cname].no_skip = true;
      calInfo[cname] = {constraints: constraints, forced_v: forced_v, preference: pref};
    }
  }

  // ── 3. Build day categories from Schedule sheet ──────────────────
  var schedSheet = ss.getSheetByName('Schedule_' + month);
  if (!schedSheet) return {success:false, error:'Schedule_' + month + ' לא נמצא. צור לוח קודם.'};
  
  var schedRows = schedSheet.getRange(1,1,schedSheet.getLastRow(),12).getValues();

  // Apply day-category overrides from the generate modal: persist them to col C
  // so the schedule sheet, the algorithm and the UI all stay consistent.
  var dayCats = null;
  try {
    if (req.dayCategories) {
      dayCats = (typeof req.dayCategories === 'string') ? JSON.parse(req.dayCategories) : req.dayCategories;
    }
  } catch(e) { dayCats = null; }
  if (dayCats) {
    var colCVals = [];
    for (var dc = 1; dc < schedRows.length; dc++) {
      var dcCell = schedRows[dc][0];
      var dcDay = dcCell instanceof Date ? dcCell.getDate() : parseInt(String(dcCell).split('/')[0]);
      var newCat = dcDay ? dayCats[String(dcDay)] : null;
      if (newCat) schedRows[dc][2] = newCat;
      colCVals.push([schedRows[dc][2]]);
    }
    if (colCVals.length) schedSheet.getRange(2, 3, colCVals.length, 1).setValues(colCVals);
  }

  // קיבועים ידניים לריצה הנוכחית בלבד — מגיעים מחלון ההפקה (לא מהתאים בגיליון!),
  // כך ש-regenerate על חודש קיים לא "יקפיא" את כל הלוח הקודם כאילו הכל מקובע.
  var PINNED_V = {};
  try {
    var pinReq = req.pinnedAssignments;
    if (pinReq) {
      var pinObj = (typeof pinReq === 'string') ? JSON.parse(pinReq) : pinReq;
      Object.keys(pinObj).forEach(function(dk){
        var nmP = String(pinObj[dk]||'').trim();
        if (nmP) PINNED_V[parseInt(dk)] = nmP;
      });
    }
  } catch(e) { Logger.log('pinnedAssignments parse error: ' + e); }

  var DAY_CAT = {}, WEEKEND_PAIRS = [];
  for (var si2 = 1; si2 < schedRows.length; si2++) {
    var dateCell = schedRows[si2][0];
    var dn = dateCell instanceof Date ? dateCell.getDate() : parseInt(String(dateCell).split('/')[0]);
    if (!dn) continue;
    var cat = String(schedRows[si2][2]||'חול').trim();
    // Normalize
    if (cat === 'שישי' || cat === 'שבת') cat = 'סוף שבוע';
    DAY_CAT[dn] = cat;
  }
  
  // Find weekend pairs (consecutive סוף שבוע days that are Fri+Sat)
  // Also find holiday pairs (consecutive חג days) - treated same as full weekends
  var daysInMonth2 = new Date(year, mon, 0).getDate();
  var HAG_PAIRS = [];
  for (var d2 = 1; d2 < daysInMonth2; d2++) {
    if (DAY_CAT[d2] === 'סוף שבוע' && DAY_CAT[d2+1] === 'סוף שבוע') {
      var dow = new Date(year, mon-1, d2).getDay(); // 5=Friday
      if (dow === 5) WEEKEND_PAIRS.push([d2, d2+1]);
    }
    // Holiday pair: two consecutive חג days (or ערב חג + חג)
    var cat_d2 = DAY_CAT[d2]||'', cat_d2n = DAY_CAT[d2+1]||'';
    if ((cat_d2 === 'חג' || cat_d2 === 'ערב חג') && cat_d2n === 'חג') {
      HAG_PAIRS.push([d2, d2+1]);
    }
  }

  // ── 4. Core helper functions ─────────────────────────────────────
  
  function fwEligible(p) {
    var last = p.last_fw;
    if (last !== null && (mon - last) < 6) return false;
    // חג in last 6 months disqualifies from full weekend
    for (var back2 = 1; back2 <= 6; back2++) {
      var mNum2 = mon - back2;
      if (mNum2 < 1) break;
      var colIdx2 = 4 + (mNum2-1)*2;
      // find this person in scoreRows
      for (var sr = 1; sr < scoreRows.length; sr++) {
        if (String(scoreRows[sr][0]||'').trim() === p.name) {
          if ((String(scoreRows[sr][colIdx2]||'').indexOf('חג') !== -1)) return false;
          break;
        }
      }
    }
    return true;
  }

  function canDoDay(name, day, isFW) {
    var p = people[name];
    if (!p) return false;
    var cat = DAY_CAT[day] || 'חול';
    if ((calInfo[name]||{}).constraints && calInfo[name].constraints[day]) return false;
    if (p.activity === '0') return false;
    if (p.dutyCategory === 'פטור' || p.dutyCategory === 'לא מוסמך' || p.dutyCategory === 'טרם הוסמך') return false;
    if (p.activity === '0.5' && cat !== 'חמישי' && cat !== 'ערב חג') return false;
    if (p.endDateObj && new Date(year, mon-1, day) > p.endDateObj) return false;
    // מלא gets FULL weekend pair or holiday pair (both days together)
    // נפרד can do any single day including weekend/holiday - no restrictions here
    return true;
  }

  function prefMatches(p, slotType) {
    var pref = ((calInfo[p.name]||{}).preference || '').trim();
    if (!pref) return false;
    var inPref = function(arr) { return arr.some(function(k){return pref.indexOf(k)!==-1;}); };
    if (inPref(['חמישי',"ה'"])) if (slotType === 'חמישי' || slotType === 'ערב חג') return true;
    if (inPref(['סוף שבוע','שישי','שבת',"ו'","ש'"])) if (slotType.indexOf('סוף שבוע')!==-1||slotType==='חג'||slotType==='חג + סוף שבוע') return true;
    if (inPref(['חול','רגיל'])) if (slotType === 'חול') return true;
    return false;
  }

  // ── 5. Schedule algorithm ────────────────────────────────────────
  
  var activeNames = Object.keys(people).filter(function(n){return people[n].activity !== '0';});
  activeNames.sort(function(a,b){ return scores[a] - scores[b]; });

  var usedV = {}, dayToV = {}, slotPrimary = {}, fwCovered = {};
  var relaxNotes = []; // transparency: records every rule relaxation applied
  var pinnedNotes = []; // transparency: records every manual pin applied by the admin

  // ── PRIORITY 0: קיבועים ידניים (נבחרו בחלון ההפקה) ──────────────
  // תורן שנבחר ידנית ליום מסוים לא ייבחר מחדש ע"י האלגוריתם, אבל כן נזקף לו
  // הניקוד המתאים ומתעדכנים last_weekend/last_fw כדי שההוגנות בהמשך תישאר נכונה.
  var pinnedDaysArr = Object.keys(PINNED_V).map(Number).sort(function(a,b){return a-b;});
  pinnedDaysArr.forEach(function(day){
    if (dayToV[day]) return; // כבר טופל (למשל כיום שני בזוג שכוסה ע"י קיבוע "מלא")
    var name = PINNED_V[day];
    var p = people[name];
    var cat = DAY_CAT[day] || 'חול';

    if (!p) {
      pinnedNotes.push('יום ' + day + ': "' + name + '" לא זוהה כתורן פעיל — הקיבוע לא הופעל');
      return;
    }

    if (usedV[name]) {
      pinnedNotes.push('⚠️ יום ' + day + ': ' + name + ' כבר קובע ליום אחר החודש — קיבוע כפול, ודא שזה מכוון');
    }

    if ((calInfo[name]||{}).constraints && calInfo[name].constraints[day]) {
      pinnedNotes.push('⚠️ יום ' + day + ': ' + name + ' קובע ידנית למרות אילוץ X שהוגש לאותו יום');
    }

    usedV[name] = true;

    // האם היום חלק מזוג (סופ"ש/חג) שהאלגוריתם רגיל לטפל בו כיחידה אחת?
    var pair = null, pairIsHag = false;
    HAG_PAIRS.forEach(function(pr){ if (pr[0]===day||pr[1]===day){ pair=pr; pairIsHag=true; } });
    if (!pair) WEEKEND_PAIRS.forEach(function(pr){ if (pr[0]===day||pr[1]===day){ pair=pr; pairIsHag=false; } });

    if (pair) {
      var d1=pair[0], d2=pair[1];
      var otherDay = (day===d1) ? d2 : d1;
      if (p.weekendType === 'מלא' && !PINNED_V[otherDay] && canDoDay(name, otherDay, true)) {
        // מלא: בדיוק כמו בהפקה רגילה — מכסה את שני הימים בציון אחד
        var pairScore = pairIsHag
          ? Math.max(DUTY_SCORES_MAP[DAY_CAT[d1]]||30, DUTY_SCORES_MAP[DAY_CAT[d2]]||30)
          : DUTY_SCORES_MAP['סוף שבוע מלא'];
        var typeLabel = pairIsHag ? 'חג' : 'סוף שבוע מלא';
        dayToV[d1] = dayToV[d2] = name;
        slotPrimary[d1] = [name, typeLabel, day===d1 ? pairScore : 0];
        slotPrimary[d2] = [name, typeLabel, day===d2 ? pairScore : 0];
        fwCovered[d1] = true; fwCovered[d2] = true;
        scores[name] += pairScore;
        people[name].last_weekend = mon;
        if (!pairIsHag) people[name].last_fw = mon;
        pinnedNotes.push('יום ' + day + ': ' + name + ' (מלא) קובע ידנית — הושלם אוטומטית גם ליום ' + otherDay);
      } else {
        // נפרד, או שהיום הצמוד כבר מקובע בנפרד בעצמו — מכסים רק את היום המקובע;
        // היום השני יטופל בנפרד ע"י האלגוריתם הרגיל (חג בודד / סופ"ש בודד)
        var singleScore = DUTY_SCORES_MAP[cat] || (pairIsHag ? 30 : 20);
        dayToV[day] = name;
        slotPrimary[day] = [name, cat, singleScore];
        fwCovered[day] = true;
        scores[name] += singleScore;
        people[name].last_weekend = mon;
        pinnedNotes.push('יום ' + day + ': ' + name + ' קובע ידנית (' + cat + ')');
      }
    } else {
      // יום עצמאי (חול / חמישי / סופ"ש בודד שלא בזוג)
      var singleScore2 = DUTY_SCORES_MAP[cat] || 10;
      dayToV[day] = name;
      slotPrimary[day] = [name, cat, singleScore2];
      scores[name] += singleScore2;
      if (cat === 'סוף שבוע') people[name].last_weekend = mon;
      pinnedNotes.push('יום ' + day + ': ' + name + ' קובע ידנית (' + cat + ')');
    }
  });

  // Does any torani have a V (forced) mark on this day?
  function dayHasV(day) {
    var names = Object.keys(calInfo);
    for (var vi = 0; vi < names.length; vi++) {
      if (calInfo[names[vi]].forced_v && calInfo[names[vi]].forced_v[day]) return true;
    }
    return false;
  }
  // Process V-marked days first within each priority group
  function sortVFirst(daysArr) {
    return daysArr.sort(function(a,b){
      var av = dayHasV(a)?0:1, bv = dayHasV(b)?0:1;
      if (av !== bv) return av - bv;
      return a - b;
    });
  }

  // ── Priority-based V assignment ──────────────────────────────────
  // Order: Holiday pairs → single holidays → weekends → thursday → regular
  // Lowest score wins regardless of מלא/נפרד type

  // Paternity (0.5) always gets Thursday first
  var thuDays = [];
  for (var d3=1;d3<=daysInMonth2;d3++){
    if (DAY_CAT[d3]==='חמישי'||DAY_CAT[d3]==='ערב חג') thuDays.push(d3);
  }
  var paternityPeople = activeNames.filter(function(n){return people[n].activity==='0.5';});
  paternityPeople.sort(function(a,b){ return scores[a]-scores[b]; });
  paternityPeople.forEach(function(pat){
    if (usedV[pat]) return; // כבר קובע ידנית ליום אחר — אל תוסיף עוד תורנות
    // Policy: משרת אב does one Thursday duty every TWO months
    var ld = people[pat].last_duty;
    if (ld !== null && (mon - ld) < 2) return;
    for(var ti=0;ti<thuDays.length;ti++){
      var thu=thuDays[ti];
      if(dayToV[thu]) continue;
      if(!canDoDay(pat,thu,false)) continue;
      usedV[pat]=true; dayToV[thu]=pat;
      var cat=DAY_CAT[thu];
      slotPrimary[thu]=[pat,cat,DUTY_SCORES_MAP[cat]||12];
      scores[pat]+=DUTY_SCORES_MAP[cat]||12;
      break;
    }
  });

  // Candidate selection. Policy: score fairness FIRST — preferences only steer placement.
  // Sort order: score → "לא לדלג" → V mark on this day → text preference.
  // prev_hag (did a חג last month) is a SOFT block on weekends: ignored only if nobody else qualifies.
  function pickLowest(days, slotType, minWeekendGap) {
    var isHagSlot = slotType === 'חג' || slotType === 'ערב חג' || slotType === 'חג + סוף שבוע';
    var isWeekendSlot = !isHagSlot && String(slotType).indexOf('סוף שבוע') !== -1;

    function collect(allowPrevHag, allowMalaSingle) {
      var candidates = [];
      var isPairSlot = isWeekendSlot || isHagSlot;
      for (var ni=0; ni<activeNames.length; ni++) {
        var n = activeNames[ni];
        if (usedV[n]) continue;
        var p = people[n];
        if (p.activity === '0.5') continue; // paternity handled separately
        // Weekend/holiday-type enforcement: a מלא torani doesn't travel through
        // Shabbat or Yom Tov, so a multi-day PAIR (full weekend OR a connected
        // holiday pair) belongs to מלא tornim only — they cover the whole thing
        // together, never just one day of it. A SINGLE day of either belongs to
        // נפרד tornim (מלא allowed on a single day only as a reported last-resort
        // fallback, when no נפרד torani is available at all).
        if (isPairSlot && days.length > 1 && p.weekendType !== 'מלא') continue;
        if (isPairSlot && days.length === 1 && p.weekendType === 'מלא' && !allowMalaSingle) continue;
        // Soft rule: חג last month → skip weekends this month (unless nobody else can)
        if (isWeekendSlot && !allowPrevHag && p.prev_hag) continue;
        // Weekend gap check (not for holidays)
        if (!isHagSlot && minWeekendGap) {
          var lw = p.last_weekend;
          if (lw !== null && (mon - lw) < minWeekendGap) continue;
        }
        // Full-weekend gap check: ONLY for actual weekends, NOT holidays
        if (!isHagSlot && days.length > 1 && p.weekendType === 'מלא') {
          if (!fwEligible(p)) continue;
        }
        var ok = days.every(function(day){return canDoDay(n, day, days.length>1);});
        if (!ok) continue;
        var noSkipFlag = p.no_skip ? 0 : 1;
        var vFlag = days.some(function(day){
          return (calInfo[n]||{}).forced_v && calInfo[n].forced_v[day];
        }) ? 0 : 1;
        var prefFlag = prefMatches(p, slotType) ? 0 : 1;
        candidates.push([scores[n], noSkipFlag, vFlag, prefFlag, n]);
      }
      candidates.sort(function(a,b){
        for(var k=0;k<4;k++){if(a[k]!==b[k])return a[k]-b[k];}return 0;
      });
      return candidates;
    }

    var candidates = collect(false, false);
    if (!candidates.length && isWeekendSlot) {
      candidates = collect(true, false);
      if (candidates.length) {
        relaxNotes.push('יום ' + days[0] + ': שובץ תורן שעשה חג בחודש הקודם (לא היה מועמד אחר)');
      }
    }
    if (!candidates.length && (isWeekendSlot || isHagSlot) && days.length === 1) {
      candidates = collect(true, true);
      if (candidates.length) {
        var slotLabel = isHagSlot ? 'יום חג בודד' : 'סוף שבוע בודד';
        relaxNotes.push('יום ' + days[0] + ': שובץ תורן מסוג "מלא" ל' + slotLabel + ' (לא היה תורן "נפרד" זמין)');
      }
    }
    if (!candidates.length) return null;
    return candidates[0][4];
  }

  // PRIORITY 1: Holiday pairs (ערב חג + חג, or חג + חג)
  // Policy: only מלא tornim take both days; נפרד tornim take a single day (pair is split).
  HAG_PAIRS.forEach(function(pair){
    var d1=pair[0], d2=pair[1];
    if (fwCovered[d1]||fwCovered[d2]) return;
    var hagScore = Math.max(DUTY_SCORES_MAP[DAY_CAT[d1]]||30, DUTY_SCORES_MAP[DAY_CAT[d2]]||30);

    // Try the full pair first — a מלא torani doesn't travel through Yom Tov, so
    // if one is available they cover both days together (same as a full weekend).
    // pickLowest with both days only ever returns a מלא candidate here (see collect()).
    var chosenPair = pickLowest([d1,d2], 'חג', null);
    if (chosenPair) {
      usedV[chosenPair]=true;
      dayToV[d1]=dayToV[d2]=chosenPair;
      slotPrimary[d1]=[chosenPair,'חג',hagScore];
      slotPrimary[d2]=[chosenPair,'חג',0];
      fwCovered[d1]=true; fwCovered[d2]=true;
      scores[chosenPair]+=hagScore;
      people[chosenPair].last_weekend=mon;
      return;
    }

    // No מלא torani available for the full pair — split it between נפרד tornim,
    // one per day (each single-day pick still excludes מלא except as last resort).
    var chosen = pickLowest([d1], 'חג', null);
    if (chosen) {
      usedV[chosen]=true;
      dayToV[d1]=chosen;
      var sc1 = DUTY_SCORES_MAP[DAY_CAT[d1]]||30;
      slotPrimary[d1]=[chosen, DAY_CAT[d1]||'חג', sc1];
      fwCovered[d1]=true;
      scores[chosen]+=sc1;
      people[chosen].last_weekend=mon;
    }
    // Assign second day separately if still uncovered
    if (!fwCovered[d2]) {
      var chosen2 = pickLowest([d2], 'חג', null);
      if (chosen2) {
        usedV[chosen2]=true; dayToV[d2]=chosen2;
        var sc2 = DUTY_SCORES_MAP[DAY_CAT[d2]]||30;
        slotPrimary[d2]=[chosen2,'חג',sc2];
        scores[chosen2]+=sc2; fwCovered[d2]=true;
        people[chosen2].last_weekend=mon;
      }
    }
  });


  // PRIORITY 1b: Single holiday days not part of a pair (V-marked days first)
  var hagSingles = [];
  for (var hd=1;hd<=daysInMonth2;hd++){
    if (fwCovered[hd]||dayToV[hd]) continue;
    var hcat0=DAY_CAT[hd]||'';
    if (hcat0==='חג'||hcat0==='ערב חג') hagSingles.push(hd);
  }
  sortVFirst(hagSingles).forEach(function(hd2){
    if (fwCovered[hd2]||dayToV[hd2]) return;
    var hcat=DAY_CAT[hd2]||'';
    var hchosen=pickLowest([hd2],'חג',null);
    if (hchosen){
      usedV[hchosen]=true; dayToV[hd2]=hchosen;
      var hsc=DUTY_SCORES_MAP[hcat]||30;
      slotPrimary[hd2]=[hchosen,hcat,hsc];
      scores[hchosen]+=hsc; fwCovered[hd2]=true;
    }
  });

  // PRIORITY 2: Weekend pairs (Fri+Sat) — מלא covers both, נפרד covers one
  WEEKEND_PAIRS.forEach(function(pair){
    var fri=pair[0], sat=pair[1];
    if (fwCovered[fri]||fwCovered[sat]) return;
    // Try as full pair first — pickLowest now only returns מלא candidates for pairs,
    // so a low-score נפרד torani no longer blocks the pair
    var chosen = pickLowest([fri,sat], 'סוף שבוע מלא', null);
    if (chosen && people[chosen].weekendType === 'מלא') {
      // מלא: covers both fri+sat
      usedV[chosen]=true; dayToV[fri]=dayToV[sat]=chosen;
      slotPrimary[fri]=[chosen,'סוף שבוע מלא',DUTY_SCORES_MAP['סוף שבוע מלא']];
      slotPrimary[sat]=[chosen,'סוף שבוע מלא',0];
      scores[chosen]+=DUTY_SCORES_MAP['סוף שבוע מלא'];
      people[chosen].last_fw=mon; people[chosen].last_weekend=mon;
      fwCovered[fri]=true; fwCovered[sat]=true;
    } else {
      // No מלא available or chosen is נפרד — assign each day separately (handled below)
      // Just mark the pair as not covered so it falls through to single-day processing
    }
  });

  // PRIORITY 2b: Single weekend days (for נפרד or unpaired)
  // Sort all remaining weekend days
  var weekendSingles = [];
  for (var wd=1;wd<=daysInMonth2;wd++){
    if (!fwCovered[wd] && !dayToV[wd] && DAY_CAT[wd]==='סוף שבוע') weekendSingles.push(wd);
  }
  // Policy: separate-weekend tornim do one weekend per 3 months.
  // Relax the gap (3 → 2 → 1 → none) only when nobody qualifies, and report it.
  sortVFirst(weekendSingles).forEach(function(day){
    if (dayToV[day]) return;
    var chosen = null, usedGap = null;
    var gapSteps = [3, 2, 1, null];
    for (var gi=0; gi<gapSteps.length; gi++){
      chosen = pickLowest([day], 'סוף שבוע', gapSteps[gi]);
      if (chosen) { usedGap = gapSteps[gi]; break; }
    }
    if (chosen) {
      if (usedGap !== 3) {
        relaxNotes.push('יום ' + day + ' (סוף שבוע): פער הסופ"שים הוקטן ל-' + (usedGap === null ? '0' : usedGap) + ' חודשים');
      }
      usedV[chosen]=true; dayToV[day]=chosen;
      slotPrimary[day]=[chosen,'סוף שבוע',DUTY_SCORES_MAP['סוף שבוע']];
      scores[chosen]+=DUTY_SCORES_MAP['סוף שבוע'];
      people[chosen].last_weekend=mon;
    }
  });

  // PRIORITY 3: 24-hour duties
  // PRIORITY 4: Thursday (חמישי / ערב חג)
  // PRIORITY 5: Regular days (חול)
  var slotOrder = [
    {cats:['חול 24 שעות','חמישי 24 שעות','הדממה'], name:'24hours'},
    {cats:['חמישי','ערב חג'], name:'thursday'},
    {cats:['חול'], name:'regular'}
  ];
  slotOrder.forEach(function(group){
    var days = [];
    for (var gd=1;gd<=daysInMonth2;gd++){
      var gc = DAY_CAT[gd]||'חול';
      if (!dayToV[gd] && !fwCovered[gd] && group.cats.indexOf(gc)!==-1) days.push(gd);
    }
    sortVFirst(days).forEach(function(day){
      if (dayToV[day]) return;
      var cat=DAY_CAT[day]||'חול';
      var chosen = pickLowest([day], cat, null);
      if (chosen) {
        usedV[chosen]=true; dayToV[day]=chosen;
        var val=DUTY_SCORES_MAP[cat]||10;
        slotPrimary[day]=[chosen,cat,val];
        scores[chosen]+=val;
      }
    });
  });

  var dolag = activeNames.filter(function(n){return !usedV[n];});

  // ── 6. Reserve A/B assignment ────────────────────────────────────
  var fwPeople = new Set(Object.keys(people).filter(function(n){return people[n].duty_type==='סוף שבוע מלא';}));
  var vIsFW = new Set();
  WEEKEND_PAIRS.forEach(function(pair){
    if(fwCovered[pair[0]]){var vp=dayToV[pair[0]];if(vp)vIsFW.add(vp);}
  });

  var personVDays = {};
  Object.keys(dayToV).forEach(function(d){
    var n=dayToV[d];
    if(!personVDays[n]) personVDays[n]=[];
    personVDays[n].push(parseInt(d));
  });

  var vGroup = {};
  Object.keys(dayToV).forEach(function(d){
    var n=dayToV[d], cat=DAY_CAT[d]||'חול';
    var grp = cat==='סוף שבוע'?'weekend':cat==='חמישי'||cat==='ערב חג'?'thursday':'weekday';
    if (!vGroup[n]) vGroup[n]=grp;
    else if (grp==='weekend') vGroup[n]='weekend';
    else if (grp==='thursday'&&vGroup[n]==='weekday') vGroup[n]='thursday';
  });

  var reservePool = activeNames.filter(function(n){return !dolag.includes(n);});
  var resA={},resB={},resTotal={},resDays={};
  reservePool.forEach(function(n){resA[n]=0;resB[n]=0;resTotal[n]=0;resDays[n]=[];});

  var MIN_GAP=3, PREF_GAP=7, MAX_RES=2;

  var vPersons = new Set(Object.values(dayToV));
  var result = {}, fwPairDone = {};

  function buildEligibleFW(fri,sat,minGap) {
    return reservePool.filter(function(n){
      if(n===dayToV[fri]) return false;
      if(vGroup[n]==='weekend'&&!vIsFW.has(n)) return false;
      if((calInfo[n]||{}).constraints&&(calInfo[n].constraints[fri]||calInfo[n].constraints[sat])) return false;
      if(people[n].activity==='0'||people[n].activity==='0.5') return false;
      var maxRes = vIsFW.has(n) ? MAX_RES*2 : MAX_RES;
      if(resTotal[n]>=maxRes) return false;
      var rds=resDays[n];
      if(rds.length&&Math.min.apply(null,rds.map(function(r){return Math.abs(fri-r);})) < minGap) return false;
      if(rds.length&&Math.min.apply(null,rds.map(function(r){return Math.abs(sat-r);})) < minGap) return false;
      var vd=personVDays[n]||[];
      if(vd.some(function(v){return Math.abs(fri-v)<MIN_GAP||Math.abs(sat-v)<MIN_GAP;})) return false;
      return true;
    });
  }

  function buildEligible(v,day,cat,requireGrp,minGap,allowFW,minVGap,maxResOvr) {
    if(minVGap===undefined) minVGap=MIN_GAP;
    if(maxResOvr===undefined) maxResOvr=MAX_RES;
    return reservePool.filter(function(n){
      if(n===v) return false;
      if(vIsFW.has(n)&&cat==='סוף שבוע') return false;
      if(fwPeople.has(n)&&(cat==='סוף שבוע'||cat==='חג')) return false;
      if(vGroup[n]==='weekday'&&cat==='סוף שבוע'&&!allowFW) return false;
      if((calInfo[n]||{}).constraints&&calInfo[n].constraints[day]) return false;
      if(people[n].activity==='0.5'&&cat!=='חמישי'&&cat!=='ערב חג') return false;
      if(resTotal[n]>=maxResOvr) return false;
      if(requireGrp&&vGroup[n]!==cat.indexOf('סוף שבוע')!==-1?'weekend':cat==='חמישי'||cat==='ערב חג'?'thursday':'weekday') {
        // simplified group check
      }
      var rds=resDays[n];
      if(rds.length&&Math.min.apply(null,rds.map(function(r){return Math.abs(day-r);})) < minGap) return false;
      var vd=personVDays[n]||[];
      if(vd.some(function(v2){return Math.abs(day-v2)<minVGap;})) return false;
      return true;
    });
  }

  function getGap(n,day) {
    var rds=resDays[n];
    if(!rds.length) return 999;
    return Math.min.apply(null,rds.map(function(r){return Math.abs(day-r);}));
  }

  function assignReserve(n,day,role) {
    result[day][role]=n;
    if(role==='A') resA[n]++;else resB[n]++;
    resTotal[n]++;
    resDays[n].push(day);
  }

  // Process days
  var allDays = [];
  for(var pd=1;pd<=daysInMonth2;pd++) if(dayToV[pd]) allDays.push(pd);

  allDays.forEach(function(day){
    if(result[day]) return;
    if(fwPairDone[day]) return;
    var v=dayToV[day];
    var cat=DAY_CAT[day]||'חול';
    var si=slotPrimary[day];
    var slotStype=si?si[1]:cat;
    var isFWSlot=slotStype==='סוף שבוע מלא'||slotStype==='חג + סוף שבוע';
    var sscore=si?si[2]:0;

    if(isFWSlot) {
      // Find sat pair
      var fwSat=null;
      WEEKEND_PAIRS.forEach(function(pair){if(pair[0]===day)fwSat=pair[1];});
      if(fwSat!==null) {
        var elig=buildEligibleFW(day,fwSat,PREF_GAP);
        if(elig.length<2) elig=buildEligibleFW(day,fwSat,MIN_GAP);
        if(elig.length<2) elig=buildEligibleFW(day,fwSat,1);

        elig.sort(function(a,b){return resA[a]-resA[b]||(scores[a]-scores[b]);});
        var afw=elig[0]||null;
        var bPool=elig.filter(function(n){return n!==afw;});
        bPool.sort(function(a,b){return resB[a]-resB[b]||(scores[a]-scores[b]);});
        var bfw=bPool[0]||null;

        if(!result[day]) result[day]={V:v,A:null,B:null,type:slotStype,score:sscore};
        if(!result[fwSat]) result[fwSat]={V:dayToV[fwSat]||v,A:null,B:null,type:slotStype,score:0};
        if(afw){result[day].A=afw;result[fwSat].A=afw;resA[afw]++;resTotal[afw]++;resDays[afw].push(fwSat);}
        if(bfw){result[day].B=bfw;result[fwSat].B=bfw;resB[bfw]++;resTotal[bfw]++;resDays[bfw].push(fwSat);}
        fwPairDone[fwSat]=true;
        return;
      }
    }

    // Single day reserves
    var elig2=buildEligible(v,day,cat,false,PREF_GAP,false,MIN_GAP,MAX_RES);
    if(elig2.length<2) elig2=buildEligible(v,day,cat,false,MIN_GAP,false,MIN_GAP,MAX_RES);
    if(elig2.length<2) elig2=buildEligible(v,day,cat,false,1,false,MIN_GAP,MAX_RES);
    if(elig2.length<2) elig2=buildEligible(v,day,cat,false,1,true,MIN_GAP,MAX_RES);
    if(elig2.length<2) elig2=buildEligible(v,day,cat,false,1,true,1,MAX_RES+1);

    elig2.sort(function(a,b){
      return (resA[a]-resA[b])||(getGap(b,day)-getGap(a,day))||(scores[a]-scores[b]);
    });
    var ar=elig2[0]||null;
    var bPool2=elig2.filter(function(n){return n!==ar;});
    bPool2.sort(function(a,b){
      return (resB[a]-resB[b])||(getGap(b,day)-getGap(a,day))||(scores[a]-scores[b]);
    });
    var br=bPool2[0]||null;

    result[day]={V:v,A:ar,B:br,type:slotStype,score:sscore};
    if(ar){resA[ar]++;resTotal[ar]++;resDays[ar].push(day);}
    if(br){resB[br]++;resTotal[br]++;resDays[br].push(day);}
  });

  // ── 7. Write to Schedule sheet ──────────────────────────────────
  var vabData=[], scoreData=[], typeData=[];
  for(var wi=1;wi<schedRows.length;wi++){
    var dateCell2=schedRows[wi][0];
    var dn2=dateCell2 instanceof Date?dateCell2.getDate():parseInt(String(dateCell2).split('/')[0]);
    var ag=result[dn2]||{V:'',A:'',B:'',score:0,type:''};
    vabData.push([ag.V||'',ag.A||'',ag.B||'']);
    scoreData.push([ag.score||0]);
    typeData.push([ag.type||schedRows[wi][7]||'']);
  }
  if(vabData.length){
    var numR=vabData.length;
    schedSheet.getRange(2,4,numR,3).setValues(vabData);
    schedSheet.getRange(2,9,numR,1).setValues(scoreData);
    schedSheet.getRange(2,8,numR,1).setValues(typeData);
  }

  // ── 8. Update Scores sheet (IDEMPOTENT: current-month columns are always
  //       overwritten — including cleared — so re-running never double-counts) ──
  var scoreSheet2=getScoresSheet(String(year));
  var monColType = 4 + (mon-1)*2 + 1; // 1-indexed for GS: col 5=ינואר סוג(E), 6=ינואר ניקוד(F)...
  var monColScore = monColType + 1;

  for(var sui=1;sui<scoreRows.length;sui++){
    var sn=String(scoreRows[sui][0]||'').trim();
    if(!sn) continue;
    if(scores[sn]===undefined) {
      if (excludedNames[sn]) {
        // Deactivated/ended: clear this month's columns and keep the total consistent
        var exBase = Number(scoreRows[sui][2])||0;
        for (var exM = 1; exM <= 12; exM++) {
          if (exM === mon) continue;
          exBase += Number(scoreRows[sui][5 + (exM-1)*2])||0;
        }
        scoreSheet2.getRange(sui+1,monColType).setValue('');
        scoreSheet2.getRange(sui+1,monColScore).setValue('');
        scoreSheet2.getRange(sui+1,4).setValue(exBase);
      }
      continue; // admin / non-torani rows untouched
    }
    // What did this person get THIS month?
    var ag2=null;
    Object.keys(result).forEach(function(d){if(result[d].V===sn&&result[d].score>0)ag2=result[d];});
    var mType='', mScore='';
    if(ag2){
      mType=ag2.type||''; mScore=ag2.score;
    } else if(people[sn]&&people[sn].activity==='0'){
      mType='פטור'; mScore=10; scores[sn]+=10;
    }
    scoreSheet2.getRange(sui+1,monColType).setValue(mType);
    scoreSheet2.getRange(sui+1,monColScore).setValue(mScore);
    // Accumulated total = clean base (computed at load, excl. this month) + this run's additions
    scoreSheet2.getRange(sui+1,4).setValue(scores[sn]);
  }

  // ── 9. Transparency summary ─────────────────────────────────────
  var totalDays=0, unassigned=[], noReserve=[];
  for(var td=1; td<=daysInMonth2; td++){
    if(DAY_CAT[td]===undefined) continue;
    totalDays++;
    if(!dayToV[td]) { unassigned.push(td); continue; }
    var rr=result[td];
    if(rr && (!rr.A || !rr.B)) noReserve.push(td);
  }
  var msg='השיבוץ הופק: ' + (totalDays-unassigned.length) + '/' + totalDays + ' ימים שובצו';
  if(unassigned.length) msg += '\n❗ ימים ללא מבצע: ' + unassigned.join(', ');
  if(noReserve.length) msg += '\n⚠️ ימים ללא עתודה מלאה: ' + noReserve.join(', ');
  if(relaxNotes.length) msg += '\n⚠️ הקלות שהופעלו:\n• ' + relaxNotes.join('\n• ');
  if(pinnedNotes.length) msg += '\n📌 קיבועים ידניים:\n• ' + pinnedNotes.join('\n• ');
  // Report only surprising exclusions (service ended); inactive/viewer accounts are expected
  var exList = Object.keys(excludedNames).filter(function(n){return excludedNames[n] === 'סיים שירות';});
  if(exList.length) msg += '\nℹ️ סיימו שירות ולא שובצו: ' + exList.join(', ');

  // ── 10. Auto-create next month's skeleton (rolling window) ───────
  // Keeps a skeleton always one month ahead so Itai never needs to bulk-build
  // years in advance again. No-ops harmlessly if the sheet already exists —
  // true for every month already covered by the original 2026-2029 bulk build.
  try {
    var nextYear = year, nextMon = mon + 1;
    if (nextMon > 12) { nextMon = 1; nextYear += 1; }
    var nextMonthKey = String(nextYear) + String(nextMon).padStart(2,'0');
    if (!ss.getSheetByName('Schedule_' + nextMonthKey)) {
      initMonthScheduleEx(nextYear, nextMon);
      setScheduleStatus(nextMonthKey, 'draft');
      msg += '\n🗓️ נוצר שלד ריק לחודש הבא (' + nextMonthKey + ') אוטומטית.';
    }
  } catch(e) { Logger.log('auto-create next month skeleton error: ' + e); }

  Logger.log('generateScheduleV2: ' + month + ' done, ' + Object.keys(result).length + ' days scheduled');
  return {success:true, message:msg};
}
