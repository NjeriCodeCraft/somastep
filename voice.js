const express = require('express');
const { GoogleGenAI } = require('@google/genai');

module.exports = function (supabase, normalizePhone, getLearner) {
  const router = express.Router();
  const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY || '').trim() });
  const MODEL = 'gemini-2.5-flash';

  // Placeholder packages. You decide the real minutes and prices.
  const PACKAGES = [
    { minutes: 60, price: 50 },
    { minutes: 120, price: 90 },
    { minutes: 180, price: 130 }
  ];

  // Used if Gemini is slow or fails, so the call never goes quiet
  const FALLBACK = [
    { topic: 'Plants and sunlight', teach: 'Plants use sunlight to make their own food. This gives them energy to grow.', question: 'What do plants use sunlight for?', options: ['Making food', 'Making noise', 'Making shoes'], correct: 1 },
    { topic: 'States of water', teach: 'Water can be liquid, ice or steam. Heat turns water into steam.', question: 'What turns water into steam?', options: ['Cold', 'Heat', 'Wind'], correct: 2 },
    { topic: 'Adding numbers', teach: 'Adding means putting numbers together to make a bigger number.', question: 'What is 7 plus 5?', options: ['11', '12', '13'], correct: 2 }
  ];

  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const wrap = (inner) => '<?xml version="1.0" encoding="UTF-8"?><Response>' + inner + '</Response>';
  const say = (t) => '<Say voice="woman">' + esc(t) + '</Say>';
  const ask = (t) => '<GetDigits timeout="20" numDigits="1">' + say(t) + '</GetDigits>';

  async function makeTurn(learner, covered) {
    const name = learner.preferred_name || learner.child_name;
    const subjects = learner.subjects && learner.subjects.length ? learner.subjects : ['Science'];
    const subject = subjects[covered.length % subjects.length];
    const done = covered.map((c) => c.topic).join(', ') || 'none';

    const prompt =
      'You are SomaStep, a warm, encouraging tutor on a phone call with ' + name + ', a ' + learner.grade +
      ' child in Kenya. Teach ONE small idea in ' + subject + ' at the Kenyan CBC level. Do not repeat these topics: ' + done +
      '. Reply ONLY with JSON, no markdown, in exactly this shape: ' +
      '{"topic": "3 to 5 words", "teach": "2 short sentences", "question": "one simple question", "options": ["a", "b", "c"], "correct": 1}. ' +
      '"correct" is the number 1, 2 or 3 of the right option. Keep everything very short, under 50 words in total, because it will be spoken aloud.';

    try {
      const call = ai.models.generateContent({ model: MODEL, contents: prompt });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout')), 8000));
      const response = await Promise.race([call, timeout]);
      const turn = JSON.parse(response.text.replace(/```json|```/g, '').trim());
      if (!turn.teach || !turn.question || !Array.isArray(turn.options) || turn.options.length !== 3 || ![1, 2, 3].includes(Number(turn.correct))) {
        throw new Error('Bad shape');
      }
      turn.correct = Number(turn.correct);
      turn.topic = turn.topic || subject;
      return turn;
    } catch (e) {
      console.log('Gemini fallback used:', e.message);
      return FALLBACK[covered.length % FALLBACK.length];
    }
  }

  function speak(turn) {
    return turn.teach + ' ' + turn.question + ' Press 1 for ' + turn.options[0] + ', 2 for ' + turn.options[1] +
      ', or 3 for ' + turn.options[2] + '. Or press 9 to stop.';
  }

  function offerPackages() {
    const lines = PACKAGES.map((p, i) =>
      'Press ' + (i + 1) + ' for ' + (p.minutes / 60) + (p.minutes === 60 ? ' hour' : ' hours') + ' at ' + p.price + ' shillings.'
    ).join(' ');
    return ask('You have no minutes left. ' + lines);
  }

  async function nextTurn(learner, state, prefix) {
    state.current = await makeTurn(learner, state.covered);
    state.stage = 'lesson';
    return ask(prefix + speak(state.current));
  }

  function goodbye(name, state, extra) {
    const right = state.covered.filter((c) => c.right).length;
    return wrap(say((extra || '') + 'You answered ' + right + ' of ' + state.covered.length +
      ' correctly. Great learning today, ' + name + '. Goodbye!'));
  }

  async function loadState(sessionId) {
    const { data } = await supabase.from('call_sessions').select('last_ai_prompt').eq('session_id', sessionId).maybeSingle();
    if (!data || !data.last_ai_prompt) return null;
    try { return JSON.parse(data.last_ai_prompt); } catch (e) { return null; }
  }

  async function saveState(sessionId, phone, state) {
    const { error } = await supabase.from('call_sessions').upsert({
      session_id: sessionId,
      phone_number: phone,
      current_question_index: state.covered.length,
      topic: state.current ? state.current.topic : null,
      last_ai_prompt: JSON.stringify(state)
    });
    if (error) console.log('saveState error:', error.message);
  }

  async function endCall(sessionId, phone, b) {
    const state = await loadState(sessionId);
    if (!state || state.ended) return;
    const learner = await getLearner(phone);
    if (!learner) return;

    // Charge only for the time after the minutes were available
    const seconds = Number(b.durationInSeconds || 0);
    const billable = Math.max(0, seconds - (state.freeSeconds || 0));
    const used = Math.ceil(billable / 60);
    const newBalance = Math.max(0, (learner.minutes_balance || 0) - used);
    await supabase.from('learners').update({ minutes_balance: newBalance }).eq('phone_number', phone);

    if (state.covered.length > 0) {
      const topics = state.covered.map((c) => c.topic).join(', ');
      const detail = state.covered.map((c) => c.topic + (c.right ? ' (understood)' : ' (needs practice)')).join('; ');
      await supabase.from('call_summaries').insert({
        phone_number: phone, session_id: sessionId, topic: topics, what_was_covered: detail
      });
    }

    state.ended = true;
    await supabase.from('call_sessions')
      .update({ last_ai_prompt: JSON.stringify(state), ended_at: new Date().toISOString() })
      .eq('session_id', sessionId);
    console.log('Call ended. Used', used, 'minutes. New balance:', newBalance);
  }

  router.post('/callback', async (req, res) => {
    const b = req.body;
    const sessionId = b.sessionId;
    const phone = normalizePhone(b.callerNumber);
    res.type('application/xml');

    try {
      if (String(b.isActive) === '0') {
        await endCall(sessionId, phone, b);
        return res.send(wrap(''));
      }

      const learner = await getLearner(phone);
      if (!learner) {
        return res.send(wrap(say('Welcome to SomaStep. Please ask a parent to register on the SomaStep USSD code first. Goodbye.')));
      }

      const name = learner.preferred_name || learner.child_name;
      const digit = String(b.dtmfDigits || '').trim();
      let state = await loadState(sessionId);

      // A brand new call
      if (!state) {
        state = {
          billStart: Date.now(),
          freeSeconds: 0,
          balance: learner.minutes_balance || 0,
          covered: [],
          current: null,
          stage: 'lesson'
        };
        if (state.balance <= 0) {
          state.stage = 'buy';
          await saveState(sessionId, phone, state);
          return res.send(wrap(offerPackages()));
        }
        const out = await nextTurn(learner, state, 'Habari ' + name + '! Welcome to SomaStep. ');
        await saveState(sessionId, phone, state);
        return res.send(wrap(out));
      }

      // Buying minutes inside the call
      if (state.stage === 'buy') {
        const pkg = PACKAGES[Number(digit) - 1];
        if (!pkg) return res.send(wrap(offerPackages()));

        // Payment is simulated for the demo. Real M-Pesa comes later.
        const newBalance = (learner.minutes_balance || 0) + pkg.minutes;
        await supabase.from('learners').update({ minutes_balance: newBalance }).eq('phone_number', phone);
        learner.minutes_balance = newBalance;

        state.balance = newBalance;
        state.freeSeconds = Math.floor((Date.now() - state.billStart) / 1000);
        state.billStart = Date.now();

        const out = await nextTurn(learner, state, 'Thank you! ' + pkg.minutes + ' minutes added. Let us learn, ' + name + '. ');
        await saveState(sessionId, phone, state);
        return res.send(wrap(out));
      }

      // Lesson in progress
      if (digit === '9') {
        return res.send(goodbye(name, state, ''));
      }
      if (!['1', '2', '3'].includes(digit) || !state.current) {
        return res.send(wrap(ask('Please press 1, 2, 3 or 9. ' + (state.current ? speak(state.current) : ''))));
      }

      const right = Number(digit) === state.current.correct;
      state.covered.push({ topic: state.current.topic, right });
      const praise = right
        ? 'Correct! Well done ' + name + '. '
        : 'Good try. The answer was ' + state.current.options[state.current.correct - 1] + '. ';

      // Out of minutes during the call?
      const usedMinutes = Math.ceil((Date.now() - state.billStart) / 60000);
      if (usedMinutes >= state.balance) {
        await saveState(sessionId, phone, state);
        return res.send(goodbye(name, state, praise + 'Your minutes are finished. Call again to top up. '));
      }

      const out = await nextTurn(learner, state, praise + 'Here is the next idea. ');
      await saveState(sessionId, phone, state);
      return res.send(wrap(out));

    } catch (err) {
      console.log('Voice error:', err.message || err);
      return res.send(wrap(say('Sorry, something went wrong. Please call again.')));
    }
  });

  return router;
};