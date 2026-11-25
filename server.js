require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const dashboardApi = require('./api')(supabase);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/api', dashboardApi.router);

app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  if (req.method === 'POST') console.log('Body:', req.body);
  next();
});

const GRADES = ['Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9'];
const SUBJECTS = ['Maths', 'Science', 'English', 'Kiswahili', 'Social Studies'];
const EXTRAS = ['English speaking', 'Debate', 'Coding', 'Music'];

function normalizePhone(p) {
  p = String(p || '').replace(/\s/g, '');
  if (p.startsWith('+')) return p;
  if (p.startsWith('254')) return '+' + p;
  if (p.startsWith('0')) return '+254' + p.slice(1);
  return p;
}

function menuList(list) {
  return list.map((item, i) => (i + 1) + '. ' + item).join('\n');
}

// "1,3" becomes ['Maths', 'English']. Returns null if anything is invalid.
function pickMany(input, list, allowNone) {
  const text = String(input).trim();
  if (allowNone && text === '0') return [];
  const nums = text.split(/[,\s]+/).filter(Boolean).map(Number);
  if (nums.length === 0) return null;
  const picked = [];
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 1 || n > list.length) return null;
    if (!picked.includes(list[n - 1])) picked.push(list[n - 1]);
  }
  return picked;
}

async function getLearner(phone) {
  const { data } = await supabase
    .from('learners')
    .select('*')
    .eq('phone_number', phone)
    .maybeSingle();
  return data;
}

const AfricasTalking = require('africastalking');
const crypto = require('crypto');

const at = AfricasTalking({
  apiKey: (process.env.AT_API_KEY || '').trim(),
  username: (process.env.AT_USERNAME || '').trim()
});

const DASHBOARD_URL = process.env.DASHBOARD_URL;
const VOICE_NUMBER = process.env.VOICE_NUMBER;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendSms(to, message) {
  try {
    await at.SMS.send({ to: [to], message });
  } catch (e) {
    console.log('SMS failed:', e.response ? e.response.status + ' ' + e.response.data : e.message);
  }
}

// Sends the three messages one after another so they arrive in order
async function sendWelcomeSms(phone, parent, name, subjects, username, code) {
  await sendSms(
    phone,
    'Hello ' + parent + '! This is SomaStep. ' + name + "'s account is ready. See progress on the dashboard: " +
      DASHBOARD_URL + ' . I will record what ' + name + ' learns and keep you updated.'
  );
  await wait(1500);
  await sendSms(
    phone,
    name + "'s subjects: " + subjects.join(', ') + '. Want another subject? Request it on the dashboard. To start learning, call ' + VOICE_NUMBER + '.'
  );
  await wait(1500);
  await sendSms(
    phone,
    'Dashboard login. Username: ' + username + ' Temporary code: ' + code + ' You can change your details after you log in.'
  );
}

const WELCOME =
  'CON Welcome to SomaStep\n1. Register\n2. Visit your account\n3. Get a personalized report';

app.get('/health', (req, res) => {
  res.json({ status: 'SomaStep is alive' });
});

app.post('/ussd', async (req, res) => {
  const phone = normalizePhone(req.body.phoneNumber);
  const text = req.body.text || '';
  const parts = text === '' ? [] : text.split('*');
  let reply;

  try {
    if (parts.length === 0) {
      reply = WELCOME;

    } else if (parts[0] === '1') {
      // Registration: 1*parent*child*callname*grade*subjects*extras*consent
      if (parts.length === 1) {
        reply = 'CON Enter your name (parent):';
      } else if (parts.length === 2) {
        reply = "CON Enter your child's full name:";
      } else if (parts.length === 3) {
        reply = 'CON What should SomaStep call ' + parts[2] + '? (nickname or first name)';
      } else if (parts.length === 4) {
        reply = 'CON Select class:\n' + menuList(GRADES);
      } else if (parts.length === 5) {
        const g = Number(parts[4]);
        if (!Number.isInteger(g) || g < 1 || g > GRADES.length) {
          reply = 'END Invalid choice. Please dial again.';
        } else {
          reply = 'CON Subjects (numbers separated by commas, e.g. 1,3):\n' + menuList(SUBJECTS);
        }
      } else if (parts.length === 6) {
        if (!pickMany(parts[5], SUBJECTS, false)) {
          reply = 'END Invalid choice. Please dial again.';
        } else {
          reply = 'CON Extra activities (e.g. 1,2) or 0 for none:\n' + menuList(EXTRAS);
        }
      } else if (parts.length === 7) {
        if (!pickMany(parts[6], EXTRAS, true)) {
          reply = 'END Invalid choice. Please dial again.';
        } else {
          reply =
            'CON SomaStep will store ' + parts[3] + "'s learning records to help them progress. Do you agree?\n1. Yes, I agree\n2. No";
        }
      } else {
        if (parts[7] !== '1') {
          reply = 'END Registration cancelled. Nothing was saved.';
        } else {
          const grade = GRADES[Number(parts[4]) - 1];
          const subjects = pickMany(parts[5], SUBJECTS, false);
          const extras = pickMany(parts[6], EXTRAS, true);

          const nameForLogin = parts[3].toLowerCase().replace(/[^a-z]/g, '') || 'learner';
          const username = nameForLogin + crypto.randomInt(100, 1000);
          const code = String(crypto.randomInt(100000, 1000000));

          const { error } = await supabase.from('learners').upsert({
            phone_number: phone,
            parent_name: parts[1].trim(),
            child_name: parts[2].trim(),
            preferred_name: parts[3].trim(),
            grade,
            subjects,
            extras,
            consent_given: true,
            dashboard_username: username,
            password_hash: dashboardApi.hashPassword(code),
            must_change: true,
            temp_code: null
          });
          if (error) throw error;

          // No await, so the USSD screen answers straight away while the SMS go out
          sendWelcomeSms(phone, parts[1].trim(), parts[3].trim(), subjects, username, code);

          reply = 'END Done! ' + parts[3].trim() + ' (' + grade + ') is registered. Check your SMS for details.';
        }
      }

    } else if (parts[0] === '2') {
      const learner = await getLearner(phone);
      if (!learner) {
        reply = 'END No child registered yet. Dial again and choose 1.';
      } else {
        const name = learner.preferred_name || learner.child_name;
        reply =
          'END ' + name + ' (' + learner.grade + ')\nSubjects: ' + (learner.subjects || []).join(', ') +
          '\nMinutes left: ' + learner.minutes_balance;
      }

    } else if (parts[0] === '3') {
      const learner = await getLearner(phone);
      if (!learner) {
        reply = 'END No child registered yet. Dial again and choose 1.';
      } else {
        const name = learner.preferred_name || learner.child_name;
        const { data: lessons } = await supabase
          .from('call_summaries')
          .select('topic')
          .eq('phone_number', phone)
          .order('created_at', { ascending: false })
          .limit(3);
        if (!lessons || lessons.length === 0) {
          reply = 'END No lessons yet for ' + name + '. After the first call you can get a report here.';
        } else {
          reply = 'END Recent lessons for ' + name + ':\n' + lessons.map((l) => l.topic).join('\n');
        }
      }

    } else {
      reply = 'END Invalid choice. Please dial again.';
    }
  } catch (err) {
    console.log('USSD error:', err.message || err);
    reply = 'END Sorry, something went wrong. Please try again.';
  }

  res.type('text/plain').send(reply);
});

app.use('/voice', require('./voice')(supabase, normalizePhone, getLearner));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('SomaStep server running on port ' + PORT));