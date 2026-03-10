// --- IN-MEMORY STORES ---
// In a production environment, this should be replaced with a database.

let jobs = [];       // all print jobs
let payments = [];   // payment records

module.exports = {
    jobs,
    payments
};
