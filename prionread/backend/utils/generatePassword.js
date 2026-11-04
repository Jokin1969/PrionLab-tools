const CHARSET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';

function generatePassword(length = 8) {
  let password = '';
  for (let i = 0; i < length; i++) {
    password += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return password;
}

module.exports = { generatePassword };
