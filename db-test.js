require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { error: insertError } = await supabase.from('learners').upsert({
    phone_number: '+254700000000',
    parent_name: 'Mama Leah',
    child_name: 'Leah',
    grade: 'Grade 5',
    subjects: ['Science'],
    consent_given: true
  });
  if (insertError) return console.log('Insert failed:', insertError.message);

  const { data, error } = await supabase.from('learners').select('*');
  if (error) return console.log('Read failed:', error.message);
  console.log('It works! Rows:', data);
}

run();