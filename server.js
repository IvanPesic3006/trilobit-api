import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import nodemailer from 'nodemailer'

const app = express()
const PORT = process.env.PORT || 3001

const allowedOrigins = [
  'http://localhost:5173',
  'https://trilobit.hr',
  'https://www.trilobit.hr',
  process.env.FRONTEND_URL,
].filter(Boolean)

const validationMessages = {
  hr: {
    nameRequired: 'Ime i prezime je obavezno.',
    nameShort: 'Ime mora imati najmanje 2 znaka.',
    emailRequired: 'Email je obavezan.',
    emailInvalid: 'Email nije ispravan.',
    messageRequired: 'Poruka je obavezna.',
    messageShort: 'Poruka mora imati najmanje 10 znakova.',
    emailNotConfigured: 'Email servis nije konfiguriran na serveru.',
    emailSendFailed: 'Email nije poslan. Pokušajte ponovo.',
  },
  en: {
    nameRequired: 'Full name is required.',
    nameShort: 'Name must be at least 2 characters.',
    emailRequired: 'Email is required.',
    emailInvalid: 'Email is not valid.',
    messageRequired: 'Message is required.',
    messageShort: 'Message must be at least 10 characters.',
    emailNotConfigured: 'Email service is not configured on the server.',
    emailSendFailed: 'Email was not sent. Please try again.',
  },
}

function validateContact({ name, email, message, lang }) {
  const t = validationMessages[lang === 'en' ? 'en' : 'hr']
  const errors = []

  const trimmedName = String(name ?? '').trim()
  const trimmedEmail = String(email ?? '').trim()
  const trimmedMessage = String(message ?? '').trim()

  if (!trimmedName) {
    errors.push(t.nameRequired)
  } else if (trimmedName.length < 2) {
    errors.push(t.nameShort)
  }

  if (!trimmedEmail) {
    errors.push(t.emailRequired)
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    errors.push(t.emailInvalid)
  }

  if (!trimmedMessage) {
    errors.push(t.messageRequired)
  } else if (trimmedMessage.length < 10) {
    errors.push(t.messageShort)
  }

  return {
    errors,
    data: {
      name: trimmedName,
      email: trimmedEmail,
      message: trimmedMessage,
    },
  }
}

function createMailTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

function isEmailConfigured() {
  if (process.env.RESEND_API_KEY) return true
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

function getEmailProvider() {
  if (process.env.RESEND_API_KEY) return 'resend'
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp'
  return 'none'
}

function buildContactEmailContent({ name, email, message }) {
  const mailTo = process.env.MAIL_TO || 'info@trilobit.hr'
  const mailFrom = process.env.MAIL_FROM || process.env.SMTP_USER || 'info@trilobit.hr'

  return {
    mailTo,
    mailFrom,
    subject: `Trilobit kontakt: ${name}`,
    text: `Ime: ${name}\nEmail: ${email}\n\nPoruka:\n${message}`,
    html: `
      <h2>Nova poruka s Trilobit web stranice</h2>
      <p><strong>Ime:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Poruka:</strong></p>
      <p>${message.replace(/\n/g, '<br>')}</p>
    `,
  }
}

async function sendViaResend({ name, email, message }) {
  const { mailTo, mailFrom, subject, text, html } = buildContactEmailContent({
    name,
    email,
    message,
  })

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Trilobit <${mailFrom}>`,
      to: [mailTo],
      reply_to: email,
      subject,
      text,
      html,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    const error = new Error(`Resend error: ${errorBody}`)
    error.code = 'RESEND_ERROR'
    error.response = errorBody
    throw error
  }

  return { sent: true }
}

async function sendViaSmtp({ name, email, message }) {
  const transporter = createMailTransporter()

  if (!transporter) {
    return { sent: false, reason: 'not_configured' }
  }

  const { mailTo, mailFrom, subject, text, html } = buildContactEmailContent({
    name,
    email,
    message,
  })

  await transporter.sendMail({
    from: mailFrom,
    to: mailTo,
    replyTo: email,
    subject,
    text,
    html,
  })

  return { sent: true }
}

async function sendContactEmail({ name, email, message }) {
  if (process.env.RESEND_API_KEY) {
    return sendViaResend({ name, email, message })
  }

  return sendViaSmtp({ name, email, message })
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true)
        return
      }
      callback(new Error('Nije dozvoljeno CORS pravilima'))
    },
  }),
)
app.use(express.json())

app.get('/api/health', (request, response) => {
  response.json({
    status: 'ok',
    message: 'Trilobit API radi',
    emailConfigured: isEmailConfigured(),
    emailProvider: getEmailProvider(),
    note:
      getEmailProvider() === 'smtp'
        ? 'Render free plan blokira SMTP portove — koristi RESEND_API_KEY'
        : null,
  })
})

app.get('/api/hello', (request, response) => {
  response.json({ message: 'Pozdrav iz Trilobit API-ja' })
})

app.post('/api/contact', async (request, response) => {
  const { name, email, message, lang } = request.body
  const { errors, data } = validateContact({ name, email, message, lang })

  if (errors.length > 0) {
    return response.status(400).json({
      success: false,
      message: errors[0],
      errors,
    })
  }

  try {
    const emailResult = await sendContactEmail(data)

    if (!emailResult.sent) {
      console.log('SMTP nije konfiguriran — poruka samo u logu:', data)
      const t = validationMessages[lang === 'en' ? 'en' : 'hr']
      return response.status(503).json({
        success: false,
        message: t.emailNotConfigured,
      })
    }

    console.log('Email poslan za:', data.email)

    return response.json({
      success: true,
      message: lang === 'en' ? 'Message received' : 'Poruka je zaprimljena',
    })
  } catch (error) {
    console.error('Greška pri slanju emaila:')
    console.error('  code:', error.code)
    console.error('  command:', error.command)
    console.error('  response:', error.response)
    console.error('  message:', error.message)
    const t = validationMessages[lang === 'en' ? 'en' : 'hr']
    return response.status(500).json({
      success: false,
      message: t.emailSendFailed,
      debug: {
        code: error.code || null,
        response: error.response || null,
      },
    })
  }
})

app.listen(PORT, () => {
  console.log(`Server sluša na http://localhost:${PORT}`)
  console.log('Email provider:', getEmailProvider())
  if (getEmailProvider() === 'smtp') {
    console.log('NAPOMENA: Render free plan blokira SMTP — dodaj RESEND_API_KEY')
  }
})
