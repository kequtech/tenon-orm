// Inject only the database dependency of the real Mail query. The surrounding
// rendering/recipient paths are intentionally outside this database pilot.
export let mailDb;
export let sql;

export function setMailContext(database, tag) {
  mailDb = database;
  sql = tag;
}

function outsidePilot() {
  throw new Error('This pilot covers getClientAddressMessageRows, not rendering or recipients.');
}

export const sanitizeEmailHtml = outsidePilot;
export const decorateRecipients = outsidePilot;
export const getClientRecipientRows = outsidePilot;
