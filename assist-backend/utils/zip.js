/**
 * ZIP 工具模块 - 使用 Node.js 内置模块实现
 * 
 * 基于 zlib + buffer 操作，无需任何外部依赖
 * 支持创建和解压 ZIP 文件（兼容标准 ZIP 格式）
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ======================== ZIP 常量 ========================

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;

// ======================== ZIP 创建 ========================

/**
 * 将目录打包为 ZIP buffer
 * @param {string} dirPath - 要打包的目录路径
 * @param {object} options - 选项
 * @param {string[]} options.exclude - 要排除的文件/目录名（默认排除 cache, logs, .DS_Store, node_modules）
 * @returns {Buffer} ZIP 文件的 Buffer
 */
function createZipFromDir(dirPath, options = {}) {
    const exclude = options.exclude || ['cache', 'logs', '.DS_Store', 'node_modules', '.backup'];
    const files = [];

    // 递归收集文件
    function collectFiles(currentDir, relativePath) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (exclude.includes(entry.name)) continue;

            const fullPath = path.join(currentDir, entry.name);
            const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                collectFiles(fullPath, relPath);
            } else if (entry.isFile()) {
                files.push({
                    path: relPath,
                    data: fs.readFileSync(fullPath),
                });
            }
        }
    }

    collectFiles(dirPath, '');
    return createZipBuffer(files);
}

/**
 * 从文件列表创建 ZIP buffer
 * @param {Array<{path: string, data: Buffer}>} files - 文件列表
 * @returns {Buffer} ZIP 文件的 Buffer
 */
function createZipBuffer(files) {
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const file of files) {
        const fileNameBuf = Buffer.from(file.path, 'utf-8');
        const compressedData = zlib.deflateRawSync(file.data);
        const crc = crc32(file.data);

        // Local file header
        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
        localHeader.writeUInt16LE(20, 4);     // version needed
        localHeader.writeUInt16LE(0, 6);      // flags
        localHeader.writeUInt16LE(8, 8);      // compression: deflate
        localHeader.writeUInt16LE(0, 10);     // mod time
        localHeader.writeUInt16LE(0, 12);     // mod date
        localHeader.writeUInt32LE(crc, 14);   // crc32
        localHeader.writeUInt32LE(compressedData.length, 18); // compressed size
        localHeader.writeUInt32LE(file.data.length, 22);      // uncompressed size
        localHeader.writeUInt16LE(fileNameBuf.length, 26);    // filename length
        localHeader.writeUInt16LE(0, 28);     // extra field length

        const localEntry = Buffer.concat([localHeader, fileNameBuf, compressedData]);
        localHeaders.push(localEntry);

        // Central directory header
        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(CENTRAL_DIR_SIG, 0);
        centralHeader.writeUInt16LE(20, 4);   // version made by
        centralHeader.writeUInt16LE(20, 6);   // version needed
        centralHeader.writeUInt16LE(0, 8);    // flags
        centralHeader.writeUInt16LE(8, 10);   // compression
        centralHeader.writeUInt16LE(0, 12);   // mod time
        centralHeader.writeUInt16LE(0, 14);   // mod date
        centralHeader.writeUInt32LE(crc, 16); // crc32
        centralHeader.writeUInt32LE(compressedData.length, 20); // compressed size
        centralHeader.writeUInt32LE(file.data.length, 24);      // uncompressed size
        centralHeader.writeUInt16LE(fileNameBuf.length, 28);    // filename length
        centralHeader.writeUInt16LE(0, 30);   // extra field length
        centralHeader.writeUInt16LE(0, 32);   // file comment length
        centralHeader.writeUInt16LE(0, 34);   // disk number
        centralHeader.writeUInt16LE(0, 36);   // internal attrs
        centralHeader.writeUInt32LE(0, 38);   // external attrs
        centralHeader.writeUInt32LE(offset, 42); // local header offset

        centralHeaders.push(Buffer.concat([centralHeader, fileNameBuf]));
        offset += localEntry.length;
    }

    // End of central directory
    const centralDirData = Buffer.concat(centralHeaders);
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
    endRecord.writeUInt16LE(0, 4);  // disk number
    endRecord.writeUInt16LE(0, 6);  // disk with central dir
    endRecord.writeUInt16LE(files.length, 8);  // entries on this disk
    endRecord.writeUInt16LE(files.length, 10); // total entries
    endRecord.writeUInt32LE(centralDirData.length, 12); // central dir size
    endRecord.writeUInt32LE(offset, 16); // central dir offset
    endRecord.writeUInt16LE(0, 20);      // comment length

    return Buffer.concat([...localHeaders, centralDirData, endRecord]);
}

// ======================== ZIP 解压 ========================

/**
 * 解压 ZIP buffer 到指定目录
 * @param {Buffer} zipBuffer - ZIP 文件的 Buffer
 * @param {string} targetDir - 解压目标目录
 * @returns {string[]} 解压出的文件路径列表
 */
function extractZipToDir(zipBuffer, targetDir) {
    const files = parseZipBuffer(zipBuffer);
    const extractedPaths = [];

    for (const file of files) {
        // 安全检查：防止 ZIP Slip 路径穿越攻击
        const targetPath = path.join(targetDir, file.path);
        const resolvedPath = path.resolve(targetPath);
        const resolvedDir = path.resolve(targetDir);
        if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
            console.warn(`[ZIP] ⚠️ 跳过危险路径: ${file.path}`);
            continue;
        }

        // 确保目录存在
        const fileDir = path.dirname(targetPath);
        if (!fs.existsSync(fileDir)) {
            fs.mkdirSync(fileDir, { recursive: true });
        }

        fs.writeFileSync(targetPath, file.data);
        extractedPaths.push(file.path);
    }

    return extractedPaths;
}

/**
 * 解析 ZIP buffer，返回文件列表
 * @param {Buffer} zipBuffer - ZIP 文件的 Buffer
 * @returns {Array<{path: string, data: Buffer}>} 文件列表
 */
function parseZipBuffer(zipBuffer) {
    const files = [];
    let offset = 0;

    while (offset < zipBuffer.length - 4) {
        const sig = zipBuffer.readUInt32LE(offset);
        if (sig !== LOCAL_FILE_HEADER_SIG) break;

        const compression = zipBuffer.readUInt16LE(offset + 8);
        const compressedSize = zipBuffer.readUInt32LE(offset + 18);
        const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
        const fileNameLen = zipBuffer.readUInt16LE(offset + 26);
        const extraLen = zipBuffer.readUInt16LE(offset + 28);

        const fileName = zipBuffer.toString('utf-8', offset + 30, offset + 30 + fileNameLen);
        const dataStart = offset + 30 + fileNameLen + extraLen;
        const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

        // 跳过目录条目
        if (!fileName.endsWith('/')) {
            let data;
            if (compression === 8) {
                // Deflate
                data = zlib.inflateRawSync(compressedData);
            } else if (compression === 0) {
                // Stored (no compression)
                data = compressedData;
            } else {
                console.warn(`[ZIP] ⚠️ 不支持的压缩方式 ${compression}，跳过: ${fileName}`);
                offset = dataStart + compressedSize;
                continue;
            }

            files.push({ path: fileName, data });
        }

        offset = dataStart + compressedSize;
    }

    return files;
}

/**
 * 列出 ZIP 中的文件列表（不解压）
 * @param {Buffer} zipBuffer - ZIP 文件的 Buffer
 * @returns {Array<{path: string, compressedSize: number, uncompressedSize: number}>}
 */
function listZipContents(zipBuffer) {
    const files = [];
    let offset = 0;

    while (offset < zipBuffer.length - 4) {
        const sig = zipBuffer.readUInt32LE(offset);
        if (sig !== LOCAL_FILE_HEADER_SIG) break;

        const compressedSize = zipBuffer.readUInt32LE(offset + 18);
        const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
        const fileNameLen = zipBuffer.readUInt16LE(offset + 26);
        const extraLen = zipBuffer.readUInt16LE(offset + 28);

        const fileName = zipBuffer.toString('utf-8', offset + 30, offset + 30 + fileNameLen);
        const dataStart = offset + 30 + fileNameLen + extraLen;

        if (!fileName.endsWith('/')) {
            files.push({
                path: fileName,
                compressedSize,
                uncompressedSize,
            });
        }

        offset = dataStart + compressedSize;
    }

    return files;
}

// ======================== CRC32 ========================

/**
 * 计算 CRC32
 */
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

module.exports = {
    createZipFromDir,
    createZipBuffer,
    extractZipToDir,
    parseZipBuffer,
    listZipContents,
};
