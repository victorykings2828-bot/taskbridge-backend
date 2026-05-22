const nodemailer = require('nodemailer');

// Create transporter - will be real when EMAIL_USER is set
const createTransporter = () => {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
  // Mock transporter for development
  return {
    sendMail: async (options) => {
      console.log('📧 [MOCK EMAIL]');
      console.log('  To:', options.to);
      console.log('  Subject:', options.subject);
      console.log('  Body:', options.text || options.html);
      return { messageId: 'mock-' + Date.now() };
    },
  };
};

const sendEmail = async ({ to, subject, html, text }) => {
  try {
    const transporter = createTransporter();
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'Employee Work Dist <noreply@example.com>',
      to,
      subject,
      html,
      text,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email send error:', error.message);
    return { success: false, error: error.message };
  }
};

const sendWelcomeEmail = async (user, tempPassword) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1E2761;">Welcome to TaskBridge</h2>
      <p>Hello <strong>${user.name}</strong>,</p>
      <p>Your account has been created. Please use the credentials below to log in:</p>
      <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
        <p><strong>Email:</strong> ${user.email}</p>
        <p><strong>Temporary Password:</strong> <code style="background:#ddd;padding:2px 6px;border-radius:4px;">${tempPassword}</code></p>
      </div>
      <p style="color: #e53e3e;"><strong>⚠️ You will be required to change your password on first login.</strong></p>
      <p>Your role: <strong>${user.role.replace('_', ' ').toUpperCase()}</strong></p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
      <p style="color: #666; font-size: 12px;">If you didn't expect this email, please ignore it.</p>
    </div>
  `;
  return sendEmail({ to: user.email, subject: 'Your Account Has Been Created', html });
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

module.exports = { sendEmail, sendWelcomeEmail, sendPasswordChangedEmail, sendPasswordResetEmail };
