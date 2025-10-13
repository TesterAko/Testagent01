import fs from 'fs-extra';
import path from 'path';
import mammoth from 'mammoth';

const trainingFolder = './memory/training';

async function extractTextFromDocx(docxPath) {
    const { value } = await mammoth.extractRawText({ path: docxPath });
    return value;
}

export async function loadTrainingDocuments() {
    const files = await fs.readdir(trainingFolder);
    const docs = [];

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const fullPath = path.join(trainingFolder, file);

        if (ext === '.txt' || ext === '.md') {
            const content = await fs.readFile(fullPath, 'utf8');
            docs.push({ file, content });

        } else if (ext === '.docx') {
            const content = await extractTextFromDocx(fullPath);
            docs.push({ file, content });
        }
    }

    return docs;
}
