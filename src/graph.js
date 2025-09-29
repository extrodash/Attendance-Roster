const ETAG_KEY_PREFIX = 'attendance_graph_etag:';
let msalApp = null;
let activeAccount = null;
let cachedConfig = null;

function resolveAuthority(config) {
  if (config.authority) return config.authority;
  if (config.tenantId) return `https://login.microsoftonline.com/${config.tenantId}`;
  return null;
}

export function isGraphConfigured(config) {
  if (!config || !config.enabled) return false;
  if (!config.clientId) return false;
  if (!config.itemResourcePath) return false;
  return Boolean(resolveAuthority(config));
}

function getScopes(config) {
  if (Array.isArray(config.scopes) && config.scopes.length) return config.scopes;
  return ['Files.ReadWrite'];
}

function getEtagKey(config) {
  return `${ETAG_KEY_PREFIX}${config.itemResourcePath}`;
}

export function getStoredEtag(config) {
  try { return localStorage.getItem(getEtagKey(config)); }
  catch (err) { console.warn('Unable to read stored eTag', err); return null; }
}

function storeEtag(config, etag) {
  try {
    if (etag) localStorage.setItem(getEtagKey(config), etag);
    else localStorage.removeItem(getEtagKey(config));
  } catch (err) {
    console.warn('Unable to persist eTag', err);
  }
}

function ensureMsal(config) {
  if (!window.msal || !window.msal.PublicClientApplication) {
    throw new Error('MSAL library not loaded.');
  }
  if (!msalApp || cachedConfig !== config) {
    const authority = resolveAuthority(config);
    msalApp = new window.msal.PublicClientApplication({
      auth: { clientId: config.clientId, authority },
      cache: {
        cacheLocation: 'localStorage',
        storeAuthStateInCookie: false
      }
    });
    cachedConfig = config;
  }
  return msalApp;
}

async function acquireToken(config, silentOnly = false) {
  const app = ensureMsal(config);
  await app.initialize?.();
  const request = { scopes: getScopes(config), account: activeAccount || app.getActiveAccount() || undefined };
  try {
    const res = await app.acquireTokenSilent(request);
    if (res && res.accessToken) return res.accessToken;
  } catch (err) {
    if (silentOnly) throw err;
    if (err instanceof window.msal.InteractionRequiredAuthError || err.errorCode === 'no_tokens_found') {
      const result = await app.acquireTokenPopup(request);
      activeAccount = result.account;
      app.setActiveAccount(activeAccount);
      storeAccountHint(activeAccount);
      return result.accessToken;
    }
    throw err;
  }
  if (!silentOnly) {
    const result = await app.acquireTokenPopup(request);
    activeAccount = result.account;
    app.setActiveAccount(activeAccount);
    storeAccountHint(activeAccount);
    return result.accessToken;
  }
  throw new Error('Unable to acquire token.');
}

function storeAccountHint(account) {
  if (!account) return;
  try { localStorage.setItem('attendance_graph_account_hint', account.username || account.homeAccountId || ''); }
  catch (err) { console.warn('Unable to store account hint', err); }
}

function getAccountHint() {
  try { return localStorage.getItem('attendance_graph_account_hint'); }
  catch (err) { return null; }
}

export async function initGraphAuth(config) {
  if (!isGraphConfigured(config)) return { account: null };
  const app = ensureMsal(config);
  const redirectResult = await app.handleRedirectPromise?.();
  if (redirectResult?.account) {
    activeAccount = redirectResult.account;
    app.setActiveAccount(activeAccount);
    storeAccountHint(activeAccount);
  }
  const existing = activeAccount || app.getActiveAccount() || app.getAllAccounts?.()[0];
  if (!existing) {
    const hint = getAccountHint();
    if (hint && app.getAllAccounts) {
      const match = app.getAllAccounts().find(acc => acc.username === hint || acc.homeAccountId === hint);
      if (match) {
        activeAccount = match;
        app.setActiveAccount(match);
      }
    }
  } else {
    activeAccount = existing;
    app.setActiveAccount(existing);
  }
  return { account: activeAccount };
}

export async function signInWithMicrosoft(config) {
  const app = ensureMsal(config);
  const result = await app.loginPopup({ scopes: getScopes(config) });
  activeAccount = result.account;
  app.setActiveAccount(activeAccount);
  storeAccountHint(activeAccount);
  return activeAccount;
}

export async function signOutMicrosoft(config) {
  if (!msalApp) return;
  const account = activeAccount || msalApp.getActiveAccount?.();
  await msalApp.logoutPopup({ account });
  activeAccount = null;
  storeEtag(config, null);
}

async function graphFetch(config, method, path, options = {}) {
  const accessToken = await acquireToken(config, options.silentOnly || false);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers,
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
  });
  if (res.status === 401 || res.status === 403) {
    if (!options.silentOnly) {
      await acquireToken(config, false);
      return graphFetch(config, method, path, { ...options, silentOnly: true });
    }
  }
  return res;
}

export async function downloadJsonFromGraph(config) {
  const res = await graphFetch(config, 'GET', `${config.itemResourcePath}/content`);
  if (res.status === 404) {
    storeEtag(config, null);
    throw Object.assign(new Error('Cloud file not found'), { code: 404 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph download failed (${res.status}): ${text}`);
  }
  const etag = res.headers.get('ETag');
  if (etag) storeEtag(config, etag);
  const text = await res.text();
  return { json: text, etag };
}

export async function uploadJsonToGraph(config, json, options = {}) {
  const etag = options.etag || getStoredEtag(config);
  const headers = {};
  if (etag) headers['If-Match'] = etag;
  const res = await graphFetch(config, 'PUT', `${config.itemResourcePath}/content`, {
    headers,
    body: typeof json === 'string' ? json : JSON.stringify(json)
  });
  if (res.status === 412) {
    throw Object.assign(new Error('Cloud copy changed. Please refresh before uploading.'), { code: 412 });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph upload failed (${res.status}): ${text}`);
  }
  const body = await res.json().catch(() => null);
  if (body?.eTag) storeEtag(config, body.eTag);
  else {
    const resEtag = res.headers.get('ETag');
    if (resEtag) storeEtag(config, resEtag);
  }
  return body;
}

export function currentAccount() {
  return activeAccount;
}
