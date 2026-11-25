require('dotenv').config();
const AfricasTalking = require('africastalking');

const at = AfricasTalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME
});

at.SMS.send({
  to: ['+254769399819'],
  message: 'Hello from SomaStep!'
}).then(console.log).catch(console.error);