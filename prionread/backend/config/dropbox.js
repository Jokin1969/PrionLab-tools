const { Dropbox } = require('dropbox');

let _dbx = null;

function getDropboxClient() {
  if (!_dbx) {
    _dbx = new Dropbox({
      clientId: process.env.DROPBOX_APP_KEY,
      clientSecret: process.env.DROPBOX_APP_SECRET,
      refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
    });
  }
  return _dbx;
}

module.exports = { getDropboxClient };
