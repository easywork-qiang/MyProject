// 动态设置当前服务器地址
document.addEventListener('DOMContentLoaded', () => {
    const currentOrigin = window.location.origin;
    const dynamicUrls = document.querySelectorAll('.dynamic-url');
    dynamicUrls.forEach(el => {
        el.textContent = currentOrigin;
    });

    // 创建全局 toast 元素
    const toast = document.createElement('div');
    toast.className = 'copy-toast';
    toast.textContent = '✓ 复制成功';
    document.body.appendChild(toast);

    let toastTimer = null;
    function showToast() {
        clearTimeout(toastTimer);
        toast.classList.add('show');
        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, 1500);
    }

    // 通用复制 + toast 函数
    async function copyAndToast(text, btn) {
        try {
            await navigator.clipboard.writeText(text);
            showToast();

            if (btn) {
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg> Copied!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.innerHTML = originalHtml;
                    btn.classList.remove('copied');
                }, 2000);
            }
        } catch (err) {
            console.error('Failed to copy text: ', err);
            alert('复制失败，请手动选择复制。');
        }
    }

    // Copy 按钮点击
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = btn.getAttribute('data-target');
            const textToCopy = document.getElementById(targetId).textContent;
            copyAndToast(textToCopy, btn);
        });
    });

    // 点击命令行代码区域也触发复制
    document.querySelectorAll('.code-block').forEach(block => {
        block.addEventListener('click', () => {
            const code = block.querySelector('code');
            if (code) {
                copyAndToast(code.textContent, null);
            }
        });
    });

    // Tab 切换逻辑
    const tabs = document.querySelectorAll('.os-tab');
    const contents = document.querySelectorAll('.install-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const targetId = tab.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');
        });
    });
    
    // 自动检测操作系统
    const platform = navigator.platform.toLowerCase();
    if (platform.includes('mac')) {
        document.querySelector('[data-target="macos"]').click();
    } else if (platform.includes('win')) {
        document.querySelector('[data-target="windows"]').click();
    }
});
