const nodemailer = require('nodemailer');

const emailConfigured = () => Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);

// Create transporter — real SMTP when EMAIL_USER/EMAIL_PASS are set.
// NOTE: We do NOT use `service: 'gmail'`. On some hosts (e.g. Render) that path
// resolves over IPv6 and fails with ENETUNREACH / connection timeout. We pin an
// explicit SMTP host on port 587 (STARTTLS) and force IPv4 with `family: 4`.
const createTransporter = () => {
  if (emailConfigured()) {
    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT || '587', 10),
      secure: false,        // false for port 587 (STARTTLS); true only for 465
      family: 4,            // force IPv4 — fixes ENETUNREACH on Render
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS, // must be a Gmail App Password, not the login password
      },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  // Mock transporter for local dev when no credentials are configured
  return {
    sendMail: async (options) => {
      console.log('📧 [MOCK EMAIL — set EMAIL_USER/EMAIL_PASS to send for real]');
      console.log('  To:', options.to);
      console.log('  Subject:', options.subject);
      return { messageId: 'mock-' + Date.now() };
    },
    verify: async () => true,
  };
};

const brevoConfigured = () => Boolean(process.env.BREVO_API_KEY);

// The verified "from" address. With Brevo you verify a single sender (e.g. your
// Gmail) in their dashboard — reuse EMAIL_USER for that, or set EMAIL_FROM_ADDR.
const senderAddress = () =>
  process.env.EMAIL_FROM_ADDR || process.env.EMAIL_USER || 'noreply@taskbridge.io';

// Send via Brevo's HTTP API (port 443 — never blocked by Render's free tier).
const sendViaBrevo = async ({ to, subject, html }) => {
  if (typeof fetch !== 'function') {
    const err = new Error('global fetch is unavailable — Node 18+ is required for Brevo email');
    err.code = 'NO_FETCH';
    throw err;
  }
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'TaskBridge', email: senderAddress() },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`Brevo ${resp.status}: ${body}`);
    err.code = `BREVO_${resp.status}`;
    throw err;
  }
  const data = await resp.json().catch(() => ({}));
  return { messageId: data.messageId || 'brevo-' + Date.now() };
};

const sendEmail = async ({ to, subject, html, text }) => {
  try {
    // 1) Preferred on Render free: Brevo HTTP API over HTTPS.
    if (brevoConfigured()) {
      const info = await sendViaBrevo({ to, subject, html });
      console.log(`✅ Email sent to ${to} via Brevo (id: ${info.messageId})`);
      return { success: true, messageId: info.messageId };
    }

    // 2) SMTP fallback (works where outbound SMTP is allowed, e.g. paid Render).
    if (emailConfigured()) {
      const transporter = createTransporter();
      const fromAddress = `TaskBridge <${process.env.EMAIL_USER}>`;
      const info = await transporter.sendMail({ from: fromAddress, to, subject, html, text });
      console.log(`✅ Email sent to ${to} via SMTP (id: ${info.messageId})`);
      return { success: true, messageId: info.messageId };
    }

    // 3) Nothing configured → mock (logs only).
    console.log(`📧 [MOCK EMAIL — set BREVO_API_KEY to send for real] To: ${to} · ${subject}`);
    return { success: true, messageId: 'mock-' + Date.now() };
  } catch (error) {
    console.error('❌ Email send FAILED');
    console.error('  To:        ', to);
    console.error('  Subject:   ', subject);
    console.error('  Error code:', error.code || 'n/a');
    console.error('  Message:   ', error.message);
    if (String(error.code).startsWith('BREVO_401')) {
      console.error('  → Brevo rejected the API key. Check BREVO_API_KEY in Render.');
    }
    if (String(error.code).startsWith('BREVO_400')) {
      console.error('  → Brevo rejected the request. Verify your sender email in Brevo (Senders & IPs).');
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ENETUNREACH') {
      console.error('  → Outbound SMTP is blocked on this host. Use BREVO_API_KEY (HTTP) instead.');
    }
    return { success: false, error: error.message, code: error.code };
  }
};

// Sent when a super admin / manager creates an account. No password is set —
// the user sets their own password via the setup-account flow on first login.
const sendAccountInviteEmail = async (user, loginUrl) => {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#0EA5E9;width:48px;height:48px;border-radius:12px;line-height:48px;color:white;font-size:22px;font-weight:bold;">T</div>
        <h2 style="color:#0F172A;margin-top:12px;font-size:22px;">You've been added to TaskBridge</h2>
      </div>
      <div style="background:#fff;border-radius:10px;padding:28px;border:1px solid #e2e8f0;">
        <p style="color:#334155;margin-top:0;">Hello <strong>${user.name}</strong>,</p>
        <p style="color:#475569;">An account has been created for you with the role <strong>${user.role.replace('_', ' ')}</strong>. To get started, sign in with your email and set your password.</p>
        <div style="background:#f1f5f9;padding:14px 16px;border-radius:8px;margin:16px 0;">
          <p style="margin:0;color:#334155;"><strong>Email:</strong> ${user.email}</p>
        </div>
        <div style="text-align:center;margin:24px 0;">
          <a href="${loginUrl}" style="background:#0EA5E9;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block;">Set up my account</a>
        </div>
        <p style="color:#94a3b8;font-size:13px;">On first sign-in you'll be asked to create your password.</p>
      </div>
      <p style="text-align:center;color:#cbd5e1;font-size:11px;margin-top:16px;">If you didn't expect this email, you can ignore it.</p>
    </div>
  `;
  return sendEmail({ to: user.email, subject: 'Set up your TaskBridge account', html });
};

// 6-digit code emailed during company signup to verify the email is real.
const sendOtpEmail = async (email, name, otp) => {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#0EA5E9;width:48px;height:48px;border-radius:12px;line-height:48px;color:white;font-size:22px;font-weight:bold;">T</div>
        <h2 style="color:#0F172A;margin-top:12px;font-size:22px;">Confirm your email</h2>
      </div>
      <div style="background:#fff;border-radius:10px;padding:28px;border:1px solid #e2e8f0;text-align:center;">
        <p style="color:#334155;margin-top:0;">Hi${name ? ' ' + name : ''}, enter this code to finish creating your TaskBridge workspace:</p>
        <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#0EA5E9;background:#f0f9ff;border:1px solid #e0f2fe;border-radius:10px;padding:16px;margin:18px 0;">${otp}</div>
        <p style="color:#94a3b8;font-size:13px;margin-bottom:0;">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
      </div>
      <p style="text-align:center;color:#cbd5e1;font-size:11px;margin-top:16px;">TaskBridge</p>
    </div>
  `;
  return sendEmail({ to: email, subject: `Your TaskBridge code: ${otp}`, html });
};

const sendPasswordChangedEmail = async (user) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1E2761;">Password Changed Successfully</h2>
      <p>Hello <strong>${user.name}</strong>,</p>
      <p>Your password has been changed successfully. If you did not make this change, please contact your administrator immediately.</p>
    </div>
  `;
  return sendEmail({ to: user.email, subject: 'Password Changed', html });
};

const sendPasswordResetEmail = async (user, resetUrl) => {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8fafc;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#0EA5E9;width:48px;height:48px;border-radius:12px;line-height:48px;color:white;font-size:22px;font-weight:bold;">T</div>
        <h2 style="color:#0F172A;margin-top:12px;font-size:22px;">Reset your password</h2>
      </div>
      <div style="background:#fff;border-radius:10px;padding:28px;border:1px solid #e2e8f0;">
        <p style="color:#334155;margin-top:0;">Hello <strong>${user.name}</strong>,</p>
        <p style="color:#475569;">We received a request to reset your TaskBridge password. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${resetUrl}" style="background:#0EA5E9;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block;">Reset Password</a>
        </div>
        <p style="color:#94a3b8;font-size:13px;">If the button doesn't work, copy this link:<br/><a href="${resetUrl}" style="color:#0EA5E9;word-break:break-all;">${resetUrl}</a></p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;"/>
        <p style="color:#94a3b8;font-size:12px;margin-bottom:0;">If you didn't request a password reset, you can safely ignore this email. Your password won't change until you click the link above.</p>
      </div>
      <p style="text-align:center;color:#cbd5e1;font-size:11px;margin-top:16px;">TaskBridge · hello@taskbridge.io</p>
    </div>
  `;
  return sendEmail({ to: user.email, subject: 'Reset your TaskBridge password', html });
};

module.exports = { sendEmail, sendAccountInviteEmail, sendOtpEmail, sendPasswordChangedEmail, sendPasswordResetEmail };
