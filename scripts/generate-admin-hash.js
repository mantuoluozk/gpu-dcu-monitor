const { hashPassword } = require("../admin-auth");

const password = process.env.ADMIN_PASSWORD_TO_HASH;
if (!password) {
  console.error("请先通过临时环境变量 ADMIN_PASSWORD_TO_HASH 提供管理员密码。");
  process.exit(1);
}

try {
  process.stdout.write(`${hashPassword(password)}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
