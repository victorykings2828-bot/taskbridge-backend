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

const sendEmail = async ({ to, subject, html, text }) => {
  const transporter = createTransporter();
  // Gmail rejects/rewrites a From that isn't the authenticated account, so when
  // real credentials are set we always send From the EMAIL_USER address.
  const fromAddress = process.env.EMAIL_USER
    ? `TaskBridge <${process.env.EMAIL_USER}>`
    : (process.env.EMAIL_FROM || 'TaskBridge <noreply@taskbridge.io>');
  try {
    const info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject,
      html,
      text,
    });
    if (emailConfigured()) console.log(`✅ Email sent to ${to} (id: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    // Detailed logging so SMTP/credential problems are diagnosable in Render logs
    console.error('❌ Email send FAILED');
    console.error('  To:        ', to);
    console.error('  Subject:   ', subject);
    console.error('  Error code:', error.code || 'n/a');
    console.error('  Command:   ', error.command || 'n/a');
    console.error('  Message:   ', error.message);
    if (error.code === 'EAUTH') {
      console.error('  → Auth rejected. Use a Gmail App Password (not your normal password) and confirm 2-Step Verification is on.');
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ENETUNREACH' || error.code === 'ECONNECTION') {
      console.error('  → Network/connection issue. Confirm port 587 outbound is allowed and family:4 is set.');
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
