/**
 * 管理后台前端逻辑
 * 负责 Dashboard 页面的图表初始化和数据加载
 */

let trendChart, platformChart, pluginChart, userGrowthChart, apiCallChart;

async function initDashboardCharts() {
    await Promise.all([
        loadTrend(7),
        loadPlatformChart(),
        loadPluginChart(),
        loadUserGrowth(30),
        loadApiCallTrend(7),
    ]);
}

async function loadTrend(days, btn) {
    if (btn) {
        btn.parentElement.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }

    try {
        const res = await fetch('/admin/api/stats/trend?days=' + days);
        const data = await res.json();

        const ctx = document.getElementById('trendChart');
        if (!ctx) return;

        if (trendChart) trendChart.destroy();

        trendChart = new Chart(ctx.getContext('2d'), {
            type: 'line',
            data: {
                labels: data.map(d => d.date.substring(5)), // MM-DD
                datasets: [{
                    label: '活跃用户',
                    data: data.map(d => d.count),
                    borderColor: '#6c5ce7',
                    backgroundColor: 'rgba(108, 92, 231, 0.08)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3,
                    pointBackgroundColor: '#6c5ce7',
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { stepSize: 1, color: '#9ca3af', font: { size: 11 } },
                        grid: { color: 'rgba(0,0,0,0.04)' },
                    },
                    x: {
                        ticks: { color: '#9ca3af', font: { size: 11 } },
                        grid: { display: false },
                    }
                }
            }
        });
    } catch (err) {
        console.error('加载趋势图失败:', err);
    }
}

async function loadPlatformChart() {
    try {
        const res = await fetch('/admin/api/stats/platforms');
        const data = await res.json();

        const ctx = document.getElementById('platformChart');
        if (!ctx) return;

        const platformNames = {
            win32: 'Windows',
            darwin: 'macOS',
            linux: 'Linux',
        };

        const colors = ['#6c5ce7', '#00cec9', '#fdcb6e', '#e17055', '#74b9ff'];

        if (platformChart) platformChart.destroy();

        platformChart = new Chart(ctx.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: data.map(d => platformNames[d.platform] || d.platform),
                datasets: [{
                    data: data.map(d => d.count),
                    backgroundColor: colors.slice(0, data.length),
                    borderWidth: 0,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { padding: 16, font: { size: 12 } },
                    },
                },
                cutout: '65%',
            }
        });
    } catch (err) {
        console.error('加载平台分布图失败:', err);
    }
}

async function loadPluginChart() {
    try {
        const res = await fetch('/admin/api/stats/plugins');
        const data = await res.json();

        const ctx = document.getElementById('pluginChart');
        if (!ctx) return;

        if (pluginChart) pluginChart.destroy();

        pluginChart = new Chart(ctx.getContext('2d'), {
            type: 'bar',
            data: {
                labels: data.map(d => d.name),
                datasets: [
                    {
                        label: '总启用',
                        data: data.map(d => d.total),
                        backgroundColor: 'rgba(108, 92, 231, 0.7)',
                        borderRadius: 4,
                    },
                    {
                        label: '当前活跃',
                        data: data.map(d => d.active),
                        backgroundColor: 'rgba(0, 184, 148, 0.7)',
                        borderRadius: 4,
                    },
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { font: { size: 12 } },
                    },
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { stepSize: 1, color: '#9ca3af', font: { size: 11 } },
                        grid: { color: 'rgba(0,0,0,0.04)' },
                    },
                    x: {
                        ticks: { color: '#9ca3af', font: { size: 11 } },
                        grid: { display: false },
                    }
                }
            }
        });
    } catch (err) {
        console.error('加载插件统计图失败:', err);
    }
}

/**
 * 用户增长趋势图
 */
async function loadUserGrowth(days, btn) {
    if (btn) {
        btn.parentElement.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }

    try {
        const res = await fetch('/admin/api/stats/user-growth?days=' + days);
        const data = await res.json();

        const ctx = document.getElementById('userGrowthChart');
        if (!ctx) return;

        if (userGrowthChart) userGrowthChart.destroy();

        userGrowthChart = new Chart(ctx.getContext('2d'), {
            type: 'line',
            data: {
                labels: data.map(d => d.date.substring(5)),
                datasets: [
                    {
                        label: '累计用户',
                        data: data.map(d => d.totalUsers),
                        borderColor: '#6c5ce7',
                        backgroundColor: 'rgba(108, 92, 231, 0.06)',
                        fill: true,
                        tension: 0.4,
                        pointRadius: 2,
                        pointBackgroundColor: '#6c5ce7',
                        borderWidth: 2,
                        yAxisID: 'y',
                    },
                    {
                        label: '每日新增',
                        data: data.map(d => d.newUsers),
                        borderColor: '#00b894',
                        backgroundColor: 'rgba(0, 184, 148, 0.5)',
                        type: 'bar',
                        borderRadius: 4,
                        borderWidth: 0,
                        yAxisID: 'y1',
                    },
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { font: { size: 12 }, usePointStyle: true, padding: 20 },
                    },
                    tooltip: {
                        callbacks: {
                            title: function(items) {
                                return items[0].label;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: true,
                        title: { display: true, text: '累计用户', color: '#6c5ce7', font: { size: 12 } },
                        ticks: { color: '#9ca3af', font: { size: 11 } },
                        grid: { color: 'rgba(0,0,0,0.04)' },
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        beginAtZero: true,
                        title: { display: true, text: '每日新增', color: '#00b894', font: { size: 12 } },
                        ticks: { stepSize: 1, color: '#9ca3af', font: { size: 11 } },
                        grid: { drawOnChartArea: false },
                    },
                    x: {
                        ticks: { color: '#9ca3af', font: { size: 11 } },
                        grid: { display: false },
                    }
                }
            }
        });
    } catch (err) {
        console.error('加载用户增长趋势图失败:', err);
    }
}

/**
 * API 调用量趋势图
 */
async function loadApiCallTrend(days, btn) {
    if (btn) {
        btn.parentElement.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }

    try {
        const res = await fetch('/admin/api/stats/api-call-trend?days=' + days);
        const result = await res.json();
        const { trend, endpoints } = result;

        const ctx = document.getElementById('apiCallChart');
        if (!ctx) return;

        if (apiCallChart) apiCallChart.destroy();

        // 为每个接口生成不同颜色的 dataset（堆叠柱状图）
        const endpointColors = [
            { bg: 'rgba(108, 92, 231, 0.7)', border: '#6c5ce7' },
            { bg: 'rgba(0, 206, 201, 0.7)', border: '#00cec9' },
            { bg: 'rgba(253, 203, 110, 0.7)', border: '#fdcb6e' },
            { bg: 'rgba(225, 112, 85, 0.7)', border: '#e17055' },
            { bg: 'rgba(116, 185, 255, 0.7)', border: '#74b9ff' },
            { bg: 'rgba(162, 155, 254, 0.7)', border: '#a29bfe' },
            { bg: 'rgba(255, 118, 117, 0.7)', border: '#ff7675' },
            { bg: 'rgba(85, 239, 196, 0.7)', border: '#55efc4' },
        ];

        const datasets = endpoints.map((ep, idx) => {
            const color = endpointColors[idx % endpointColors.length];
            return {
                label: ep,
                data: trend.map(d => d.byEndpoint[ep] || 0),
                backgroundColor: color.bg,
                borderColor: color.border,
                borderWidth: 1,
                borderRadius: 3,
                stack: 'calls',
            };
        });

        // 如果没有按接口的数据，显示总量
        if (endpoints.length === 0) {
            datasets.push({
                label: '总调用量',
                data: trend.map(d => d.total),
                backgroundColor: 'rgba(108, 92, 231, 0.7)',
                borderColor: '#6c5ce7',
                borderWidth: 1,
                borderRadius: 3,
            });
        }

        // 添加错误数折线
        const hasErrors = trend.some(d => d.error > 0);
        if (hasErrors) {
            datasets.push({
                label: '错误数',
                data: trend.map(d => d.error),
                type: 'line',
                borderColor: '#e17055',
                backgroundColor: 'rgba(225, 112, 85, 0.1)',
                fill: false,
                tension: 0.4,
                pointRadius: 3,
                pointBackgroundColor: '#e17055',
                borderWidth: 2,
                borderDash: [4, 4],
            });
        }

        apiCallChart = new Chart(ctx.getContext('2d'), {
            type: 'bar',
            data: {
                labels: trend.map(d => d.date.substring(5)),
                datasets,
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { font: { size: 11 }, usePointStyle: true, padding: 16 },
                    },
                    tooltip: {
                        callbacks: {
                            footer: function(items) {
                                const total = items.reduce((s, item) => s + (item.raw || 0), 0);
                                return '合计: ' + total;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        stacked: true,
                        title: { display: true, text: '调用次数', color: '#6c5ce7', font: { size: 12 } },
                        ticks: { color: '#9ca3af', font: { size: 11 } },
                        grid: { color: 'rgba(0,0,0,0.04)' },
                    },
                    x: {
                        stacked: true,
                        ticks: { color: '#9ca3af', font: { size: 11 } },
                        grid: { display: false },
                    }
                }
            }
        });
    } catch (err) {
        console.error('加载 API 调用量趋势图失败:', err);
    }
}

// 页面加载后自动初始化
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('trendChart')) {
        initDashboardCharts();
    }
});
