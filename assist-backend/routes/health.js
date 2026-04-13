/**
 * 健康检查接口
 * GET /api/health
 */

const express = require('express');
const llm = require('../services/llm');

const router = express.Router();

router.get('/', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        llm: llm.getStatus(),
    });
});

module.exports = router;
