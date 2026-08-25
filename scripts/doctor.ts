import { diagnoseGatewayEnvironment } from "../apps/gateway/src/doctor.js";

const checks = await diagnoseGatewayEnvironment(process.env, {
  live: process.argv.includes("--live"),
});
for (const item of checks) console.log(JSON.stringify(item));
const errors = checks.filter((item) => item.status === "error").length;
console.log(
  JSON.stringify({
    event: "gateway_doctor_completed",
    ok: errors === 0,
    checks: checks.length,
    errors,
  }),
);
if (errors > 0) process.exitCode = 1;
