const pupp = require('./pupp.js');
const { getProxySessions, getDirectCookie, updateDirectCookie } = require('./prox.js');

async function testRecovery() {
  console.log("1. Running initial login for direct connection...");
  const cookies = await pupp.getCookies(null);
  console.log("Initial direct cookies:", cookies ? "Retrieved successfully" : "None");

  console.log("\n2. Simulating expired session by manually setting cookies to invalid value...");
  updateDirectCookie("ASP.NET_SessionId=invalid_session_id_expired; guest_city_id=28");
  console.log("Direct cookie updated in prox.js to invalid value.");

  console.log("\n3. Calling fetchViaProxy, which should hit x-ap-user-type guest, throw an error, trigger force re-authentication, and retry successfully...");
  try {
    const result = await pupp.fetchViaProxy(null, "https://autopiter.ru/api/api/searchdetails?detailNumber=JRAT5015");
    console.log("Result received from fetchViaProxy:", result && result.data ? "SUCCESS (data exists)" : "FAILED (empty data)");
    
    const finalCookies = getDirectCookie();
    console.log("Final direct cookies after healing:", finalCookies.includes("invalid_session_id") ? "STILL INVALID (HEALING FAILED)" : "HEALED SUCCESSFULLY!");
  } catch (err) {
    console.error("Test failed with error:", err);
  } finally {
    console.log("\nClosing all sessions...");
    await pupp.closeAllSessions();
  }
}

testRecovery();
