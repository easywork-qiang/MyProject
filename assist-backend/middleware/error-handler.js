/**
 * 全局错误处理中间件
 */

function errorHandler(err, req, res, _next) {
    console.error('[Error]', err.stack || err.message);

    // Multer 文件大小错误
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: '文件过大', code: 'FILE_TOO_LARGE' });
    }

    const status = err.status || err.statusCode || 500;
    res.status(status).json({
        error: err.message || '服务器内部错误',
        code: err.code || 'INTERNAL_ERROR',
    });
}

module.exports = errorHandler;
