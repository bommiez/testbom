const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const sqlite3 = require('sqlite3').verbose();
const PDFDocument = require('pdfkit');

const db = new sqlite3.Database(':memory:');
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');


app.get('/' , (req, res) =>  {
  return res.render('index')
});
app.post('/create' , (req, res) =>  {
// อ่านไฟล์ dictionary
fs.readFile('dictionary.txt', 'utf8', (err, data) => {
  if (err) {
    console.error('Error reading the dictionary file:', err);
    return;
  }

 // แยกคำศัพท์
const words = data.split('\n').filter(word => word.trim() !== '');
db.serialize(() => {
  db.run("CREATE TABLE words (word TEXT)");

  const insertStmt = db.prepare("INSERT INTO words (word) VALUES (?)");

  words.forEach(word => {
    insertStmt.run(word);
  });

  insertStmt.finalize();
});
// ใช้ async function เพื่อจัดการการเขียนไฟล์
(async () => {
  for (const word of words) {
    const lowerCaseWord = word.toLowerCase();
    const dirPath = path.join('output', lowerCaseWord[0], lowerCaseWord[1] || '');
    
    // สร้างไดเรกทอรีแบบ async
    await fs.promises.mkdir(dirPath, { recursive: true });

    const filePath = path.join(dirPath, `${lowerCaseWord}.txt`);
    const content = (lowerCaseWord + '\n').repeat(100);

    // เขียนไฟล์แบบ async
    await fs.promises.writeFile(filePath, content);
    console.log(`File ${filePath} created.`);
   
  }
  res.redirect('/show-files');
})().catch(err => console.error('Error in async operation:', err));
  
});
});

app.get('/show-files', async (req, res) => {
  try {
    const dirPath = path.join(__dirname, 'output');
    const folders = await fs.promises.readdir(dirPath);
    let filesInfo = [];

    for (const folder of folders) {
      const folderPath = path.join(dirPath, folder);
      const stats = await fs.promises.stat(folderPath);

      if (stats.isDirectory()) {
        const originalSize = (await getFolderSize(folderPath)) / 1024; // KB

        // บีบอัดโฟลเดอร์
        const zipFilePath = path.join(__dirname, 'zipped_output', `${folder}.zip`);
        const zip = new AdmZip();
        zip.addLocalFolder(folderPath);
        zip.writeZip(zipFilePath);

        // ขนาดของไฟล์ zip
        const zipStats = await fs.promises.stat(zipFilePath);
        const compressedSize = zipStats.size / 1024; // KB

        const reductionPercent = ((originalSize - compressedSize) / originalSize) * 100;

        filesInfo.push({
          folder,
          originalSize: originalSize.toFixed(2),
          compressedSize: compressedSize.toFixed(2),
          reductionPercent: reductionPercent.toFixed(2),
        });
      }
    }
    db.serialize(async () =>  {
      db.get("SELECT COUNT(*) as count FROM words WHERE LENGTH(word) > 5", (err, row1) => {
        if (err) {
          console.error('Error querying the database:', err);
          return;
        }
        const moreThanFive = row1.count;
  
        // ดึงคำทั้งหมดและคำนวณคำที่มีตัวอักษรซ้ำในคำมากกว่าหรือเท่ากับ 2 ตัวอักษร
        db.all("SELECT word FROM words", (err, rows) => {
          if (err) {
            console.error('Error querying the database:', err);
            return;
          }
  
          let repeatingChars = 0;
          let sameStartEnd = 0;
  
          rows.forEach(row => {
            const word = row.word;
  
            // นับตัวอักษรซ้ำ
            const charCounts = {};
            for (const char of word) {
              if (charCounts[char]) {
                charCounts[char]++;
              } else {
                charCounts[char] = 1;
              }
            }
  
            if (Object.values(charCounts).some(count => count >= 2)) {
              repeatingChars++;
            }
  
            // เช็คว่าคำขึ้นต้นและลงท้ายด้วยตัวอักษรเดียวกันหรือไม่
            if (word[0] === word[word.length - 1]) {
              sameStartEnd++;
            }
          });
           // Query 7.4: อัพเดตคำที่มีทั้งหมดให้ตัวอักษรตัวแรกเป็นตัวพิมพ์ใหญ่
            db.run("UPDATE words SET word = UPPER(SUBSTR(word, 1, 1)) || SUBSTR(word, 2)", (err) => {
              if (err) {
                console.error('Error updating the database:', err);
              } else {
                console.log('Updated all words with the first letter capitalized');
              }
            });
           getPDF();
          res.render('showfile', { filesInfo,moreThanFive, repeatingChars, sameStartEnd });
        });
      });
    });
    
  } catch (err) {
    console.error('Error reading directory:', err);
    res.status(500).send('Error reading directory');
  }
});

async function getFolderSize(dirPath) {
  let totalSize = 0;
  const files = await fs.promises.readdir(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stats = await fs.promises.stat(filePath);

    if (stats.isFile()) {
      totalSize += stats.size;
    } else if (stats.isDirectory()) {
      totalSize += await getFolderSize(filePath);
    }
  }

  return totalSize;
}

// ฟังก์ชันส่งออกคำในฐานข้อมูลเป็น PDF
function getPDF() {
  db.all("SELECT word FROM words", (err, rows) => {
    if (err) {
      console.error('Error querying the database:', err);
      return;
    }

    // สร้างเอกสาร PDF
    const doc = new PDFDocument();
    const filePath = path.join(__dirname, 'dictionary.pdf');
    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);

    // เขียนคำแต่ละคำลงใน PDF
    rows.forEach(row => {
      doc.text(row.word);
    });

    doc.end();

    writeStream.on('finish', () => {
      console.log('PDF created successfully.');
      // สามารถทำการดาวน์โหลดไฟล์หรือแสดงผลต่อไปได้
    });
  });
}

app.listen(3000, () => {
  console.log('Server running on port 3000');
});