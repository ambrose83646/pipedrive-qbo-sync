const Database = require("@replit/database");
const db = new Database();

async function getUser(key) {
  try {
    const result = await db.get(key);
    // db.get() returns { ok: true, value: {...} }
    return result?.value || null;
  } catch (error) {
    console.error(`Error getting user with key ${key}:`, error);
    throw error;
  }
}

async function setUser(key, data) {
  try {
    await db.set(key, data);
    return true;
  } catch (error) {
    console.error(`Error setting user with key ${key}:`, error);
    throw error;
  }
}

async function deleteUser(key) {
  try {
    await db.delete(key);
    return true;
  } catch (error) {
    console.error(`Error deleting user with key ${key}:`, error);
    throw error;
  }
}

async function listUsers(prefix = '') {
  try {
    const result = await db.list(prefix);
    // db.list() returns { ok: true, value: [...] }
    return result?.value || [];
  } catch (error) {
    console.error('Error listing users:', error);
    throw error;
  }
}

module.exports = {
  getUser,
  setUser,
  deleteUser,
  listUsers
};
