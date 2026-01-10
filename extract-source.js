const fs = require('fs');
const { SourceMapConsumer } = require('source-map');

async function extractSource() {
    const mapContent = fs.readFileSync('./out/extension.js.map', 'utf8');
    const map = JSON.parse(mapContent);
    
    // source-map 文件中通常包含 sourcesContent
    if (map.sourcesContent && map.sourcesContent.length > 0) {
        console.log('Found sourcesContent, extracting...');
        for (let i = 0; i < map.sources.length; i++) {
            const sourcePath = map.sources[i];
            const content = map.sourcesContent[i];
            if (content) {
                // 创建目录
                const dir = require('path').dirname(sourcePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                // 写入文件
                const outputPath = sourcePath.replace('../', './');
                fs.writeFileSync(outputPath, content);
                console.log(`Extracted: ${outputPath} (${content.length} bytes)`);
            }
        }
    } else {
        console.log('No sourcesContent found in map file');
        console.log('Map keys:', Object.keys(map));
    }
}

extractSource().catch(console.error);

