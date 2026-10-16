function errorHandler(err, _req, res, _next) {
  const msg = err.reason || err.error?.message || err.message || "internal error";
  const code = err.status || (err.code === "CALL_EXCEPTION" ? 400 : 500);
  res.status(code).json({ success: false, error: { message: msg } });
}

module.exports = { errorHandler };
