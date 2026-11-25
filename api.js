const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cors = require('cors');

module.exports = function (supabase) {
  const router = express.Router();
  const SECRET = process.env.JWT_SECRET;
  if (!SECRET) console.log('WARNING: JWT_SECRET is missing in .env');

  router.use(cors());

  function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    return salt + ':' + hash;
  }

  function checkPassword(pw, stored) {
    if (!stored || !stored.includes(':')) return false;
    const parts = stored.split(':');
    const test = crypto.scryptSync(String(pw), parts[0], 32);
    const real = Buffer.from(parts[1], 'hex');
    return real.length === test.length && crypto.timingSafeEqual(real, test);
  }

  // Slows down guessing: 5 wrong tries per 15 minutes for each username
  const attempts = new Map();
  function tooMany(key) {
    const now = Date.now();
    const list = (attempts.get(key) || []).filter((t) => now - t < 900000);
    attempts.set(key, list);
    return list.length >= 5;
  }
  function recordFail(key) {
    attempts.set(key, (attempts.get(key) || []).concat(Date.now()));
  }

  function sign(phone, mustChange) {
    return jwt.sign({ phone, mc: !!mustChange }, SECRET, { expiresIn: '12h' });
  }

  function auth(allowMustChange) {
    return (req, res, next) => {
      const header = req.headers.authorization || '';
      try {
        const payload = jwt.verify(header.replace('Bearer ', ''), SECRET);
        if (payload.mc && !allowMustChange) {
          return res.status(403).json({ error: 'Please change your temporary code first.', must_change: true });
        }
        req.phone = payload.phone;
        next();
      } catch (e) {
        res.status(401).json({ error: 'Please log in again.' });
      }
    };
  }

  router.post('/login', async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) return res.status(400).json({ error: 'Enter your username and code.' });
    if (tooMany(username)) return res.status(429).json({ error: 'Too many tries. Please wait 15 minutes.' });

    const { data: learner } = await supabase
      .from('learners')
      .select('phone_number, password_hash, must_change')
      .eq('dashboard_username', username)
      .maybeSingle();

    if (!learner || !checkPassword(password, learner.password_hash)) {
      recordFail(username);
      return res.status(401).json({ error: 'Wrong username or code.' });
    }
    res.json({ token: sign(learner.phone_number, learner.must_change), must_change: !!learner.must_change });
  });

  router.post('/change-password', auth(true), async (req, res) => {
    const pw = String((req.body && req.body.new_password) || '');
    if (pw.length < 8) return res.status(400).json({ error: 'Use at least 8 characters.' });
    const { error } = await supabase
      .from('learners')
      .update({ password_hash: hashPassword(pw), must_change: false })
      .eq('phone_number', req.phone);
    if (error) return res.status(500).json({ error: 'Could not save. Please try again.' });
    res.json({ token: sign(req.phone, false), must_change: false });
  });

  router.get('/me', auth(false), async (req, res) => {
    const { data } = await supabase
      .from('learners')
      .select('parent_name, child_name, preferred_name, grade, subjects, extras, minutes_balance')
      .eq('phone_number', req.phone)
      .maybeSingle();
    if (!data) return res.status(404).json({ error: 'Account not found.' });
    res.json(data);
  });

  router.get('/lessons', auth(false), async (req, res) => {
    const { data } = await supabase
      .from('call_summaries')
      .select('topic, what_was_covered, created_at')
      .eq('phone_number', req.phone)
      .order('created_at', { ascending: false })
      .limit(50);

    const lessons = (data || []).map((row) => ({
      date: row.created_at,
      topics: String(row.what_was_covered || '')
        .split('; ')
        .filter(Boolean)
        .map((item) => ({
          topic: item.replace(/\s*\((understood|needs practice)\)\s*$/, ''),
          understood: item.includes('(understood)')
        }))
    }));
    res.json(lessons);
  });

  return { router, hashPassword };
};