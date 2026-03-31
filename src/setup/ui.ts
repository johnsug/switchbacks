import { STRAVA_CLIENT_ID, STRAVA_REDIRECT_URI, STRAVA_SCOPE } from "./constants.js";

export function getSetupHtml(): string {
  const stravaAuthUrl = `https://www.strava.com/oauth/authorize?${new URLSearchParams({
    client_id:    STRAVA_CLIENT_ID,
    redirect_uri: STRAVA_REDIRECT_URI,
    response_type: "code",
    scope:        STRAVA_SCOPE,
    approval_prompt: "auto",
  })}`;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Switchbacks — Connect Account</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .card {
      background: #fff;
      border-radius: 20px;
      padding: 44px 40px 40px;
      width: 420px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.13);
    }

    /* ── Header ── */
    .wordmark {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: #888;
      margin-bottom: 6px;
    }
    .headline {
      font-size: 22px;
      font-weight: 700;
      color: #111;
      margin-bottom: 4px;
    }
    .subhead {
      font-size: 14px;
      color: #888;
      margin-bottom: 32px;
    }

    /* ── Service buttons ── */
    .service-btn {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 15px 18px;
      border: 1.5px solid #e5e7eb;
      border-radius: 12px;
      background: #fff;
      cursor: pointer;
      font-size: 15px;
      font-weight: 600;
      color: #111;
      margin-bottom: 12px;
      transition: border-color .15s, box-shadow .15s, transform .1s;
      text-align: left;
    }
    .service-btn:hover {
      border-color: #c5c8cf;
      box-shadow: 0 2px 10px rgba(0,0,0,0.07);
      transform: translateY(-1px);
    }
    .service-btn:active { transform: translateY(0); }

    .svc-icon {
      width: 38px; height: 38px;
      border-radius: 9px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .svc-icon.strava { background: #FC4C02; }
    .svc-icon.garmin { background: #007DC5; }

    /* ── Back link ── */
    .back {
      display: inline-flex; align-items: center; gap: 5px;
      background: none; border: none; cursor: pointer;
      font-size: 13px; color: #888;
      margin-bottom: 22px;
      transition: color .15s;
    }
    .back:hover { color: #444; }

    /* ── Garmin form ── */
    .form-title  { font-size: 20px; font-weight: 700; color: #111; margin-bottom: 4px; }
    .form-sub    { font-size: 13px; color: #888; margin-bottom: 22px; }

    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: 11px 13px;
      border: 1.5px solid #e5e7eb;
      border-radius: 9px;
      font-size: 15px;
      color: #111;
      outline: none;
      margin-bottom: 10px;
      transition: border-color .15s;
    }
    input:focus { border-color: #007DC5; }

    .primary-btn {
      width: 100%;
      padding: 12px;
      background: #007DC5;
      color: #fff;
      border: none;
      border-radius: 9px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 18px;
      transition: background .15s, opacity .15s;
    }
    .primary-btn:hover:not(:disabled)  { background: #0069a8; }
    .primary-btn:disabled { opacity: .55; cursor: not-allowed; }

    /* ── Divider ── */
    .divider {
      display: flex; align-items: center; gap: 10px;
      color: #bbb; font-size: 12px; margin-bottom: 14px;
    }
    .divider::before, .divider::after {
      content: ""; flex: 1; height: 1px; background: #e9eaeb;
    }

    /* ── SSO buttons ── */
    .sso-btn {
      width: 100%;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 11px;
      border: 1.5px solid #e5e7eb;
      border-radius: 9px;
      background: #fff;
      font-size: 14px;
      font-weight: 500;
      color: #111;
      cursor: pointer;
      margin-bottom: 10px;
      transition: background .15s;
    }
    .sso-btn:hover { background: #f6f7f8; }
    .sso-btn.apple { background: #000; color: #fff; border-color: #000; }
    .sso-btn.apple:hover { background: #1a1a1a; }

    /* ── Error ── */
    .error-msg {
      font-size: 13px; color: #c0392b;
      min-height: 18px; margin-top: 6px;
    }

    /* ── Waiting ── */
    .waiting-wrap {
      text-align: center; padding: 12px 0 4px;
    }
    .waiting-wrap .icon  { font-size: 44px; margin-bottom: 14px; }
    .waiting-wrap h2     { font-size: 19px; font-weight: 700; color: #111; margin-bottom: 8px; }
    .waiting-wrap p      { font-size: 14px; color: #777; line-height: 1.5; }
    .spinner-ring {
      width: 36px; height: 36px;
      border: 3px solid #e5e7eb;
      border-top-color: #007DC5;
      border-radius: 50%;
      animation: spin .75s linear infinite;
      margin: 22px auto 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Success ── */
    .success-wrap { text-align: center; padding: 8px 0; }
    .success-wrap .check { font-size: 52px; margin-bottom: 14px; }
    .success-wrap h2 { font-size: 21px; font-weight: 700; color: #111; margin-bottom: 8px; }
    .success-wrap p  { font-size: 14px; color: #777; line-height: 1.6; }

    [hidden] { display: none !important; }
  </style>
</head>
<body>
<div class="card">

  <!-- ── Step 1: Choose service ── -->
  <div id="step-choose">
    <p class="wordmark">Switchbacks</p>
    <h1 class="headline">Connect your account</h1>
    <p class="subhead">Choose the service where your runs are recorded</p>

    <button class="service-btn" onclick="chooseStrava()">
      <div class="svc-icon strava">
        <!-- Strava "S" chevron -->
        <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
          <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/>
        </svg>
      </div>
      <div>
        <div>Continue with Strava</div>
        <div style="font-size:12px;font-weight:400;color:#888;margin-top:1px">Includes Google &amp; Apple sign-in</div>
      </div>
    </button>

    <button class="service-btn" onclick="chooseGarmin()">
      <div class="svc-icon garmin">
        <!-- Garmin compass icon -->
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="white" stroke-width="1.8"/>
          <polygon points="12,4 14.5,12 12,14 9.5,12" fill="white"/>
          <polygon points="12,20 9.5,12 12,14 14.5,12" fill="rgba(255,255,255,0.45)"/>
        </svg>
      </div>
      <div>
        <div>Continue with Garmin</div>
        <div style="font-size:12px;font-weight:400;color:#888;margin-top:1px">Email, Google, or Apple</div>
      </div>
    </button>
  </div>

  <!-- ── Step 2: Garmin sign-in ── -->
  <div id="step-garmin" hidden>
    <button class="back" onclick="show('step-choose')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 18 9 12 15 6"/></svg>
      Back
    </button>
    <h2 class="form-title">Sign in to Garmin</h2>
    <p class="form-sub">Use your Garmin Connect credentials</p>

    <form id="garmin-form" onsubmit="submitGarminPassword(event)">
      <input type="email"    id="g-email" placeholder="Email address" autocomplete="email" required>
      <input type="password" id="g-pass"  placeholder="Password" autocomplete="current-password" required>
      <button type="submit" id="g-submit" class="primary-btn">Sign In</button>
    </form>
    <p class="error-msg" id="g-error"></p>

    <div class="divider">or</div>

    <!-- Google -->
    <button class="sso-btn" onclick="garminSSO('google')">
      <svg width="18" height="18" viewBox="0 0 24 24">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
      Continue with Google
    </button>

    <!-- Apple -->
    <button class="sso-btn apple" onclick="garminSSO('apple')">
      <svg width="15" height="18" viewBox="0 0 814 1000" fill="white">
        <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 488.6 29.8 367.1 29.8 247.4c0-198.4 129.2-303.7 256.4-303.7 68 0 124.4 44.8 167.9 44.8 42.2 0 108.2-47.7 181.5-47.7 35.1 0 107.5 9.6 157.2 73.7zm-234.5-172.4c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/>
      </svg>
      Continue with Apple
    </button>
  </div>

  <!-- ── Step 3: SSO waiting ── -->
  <div id="step-sso-wait" hidden>
    <div class="waiting-wrap">
      <div class="icon">🪟</div>
      <h2>Sign in to Garmin</h2>
      <p>A browser window just opened.<br>Complete sign-in there — this page will update automatically.</p>
      <div class="spinner-ring"></div>
    </div>
  </div>

  <!-- ── Step 4: Success ── -->
  <div id="step-success" hidden>
    <div class="success-wrap">
      <div class="check">✅</div>
      <h2>You're connected!</h2>
      <p>Close this window and return to Claude.<br>Ask anything about your runs.</p>
    </div>
  </div>

</div>
<script>
  function show(id) {
    ["step-choose","step-garmin","step-sso-wait","step-success"]
      .forEach(s => document.getElementById(s).hidden = (s !== id));
  }

  function chooseStrava() {
    window.location.href = ${JSON.stringify(stravaAuthUrl)};
  }

  function chooseGarmin() { show("step-garmin"); }

  async function submitGarminPassword(e) {
    e.preventDefault();
    const btn  = document.getElementById("g-submit");
    const errEl = document.getElementById("g-error");
    errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Signing in…";

    try {
      const res  = await fetch("/auth/garmin/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email:    document.getElementById("g-email").value,
          password: document.getElementById("g-pass").value,
        }),
      });
      const data = await res.json();
      if (data.success) { show("step-success"); }
      else {
        errEl.textContent = data.error || "Sign-in failed. Check your credentials.";
        btn.disabled = false;
        btn.textContent = "Sign In";
      }
    } catch {
      errEl.textContent = "Connection error — please try again.";
      btn.disabled = false;
      btn.textContent = "Sign In";
    }
  }

  async function garminSSO(provider) {
    show("step-sso-wait");
    try {
      const res  = await fetch("/auth/garmin/sso?provider=" + provider, { method: "POST" });
      const data = await res.json();
      if (data.success) { show("step-success"); }
      else {
        show("step-garmin");
        document.getElementById("g-error").textContent = data.error || "Sign-in failed. Please try again.";
      }
    } catch {
      show("step-garmin");
      document.getElementById("g-error").textContent = "Connection error — please try again.";
    }
  }

  // Show error from Strava redirect if present
  const params = new URLSearchParams(location.search);
  if (params.get("error")) {
    show("step-choose");
    // Surface error as an alert — user should see why Strava failed
    setTimeout(() => alert("Strava sign-in failed: " + params.get("error")), 100);
  }
</script>
</body>
</html>`;
}

export function getSuccessHtml(service: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Switchbacks — Connected</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f0f2f5; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 20px; padding: 52px 44px;
            width: 420px; box-shadow: 0 8px 40px rgba(0,0,0,0.13); text-align: center; }
    h1 { font-size: 22px; font-weight: 700; margin: 14px 0 8px; }
    p  { font-size: 14px; color: #777; line-height: 1.6; }
  </style>
</head>
<body>
<div class="card">
  <div style="font-size:54px">✅</div>
  <h1>Connected to ${service}!</h1>
  <p>You're all set.<br>Close this window and return to Claude to explore your runs.</p>
</div>
</body>
</html>`;
}
