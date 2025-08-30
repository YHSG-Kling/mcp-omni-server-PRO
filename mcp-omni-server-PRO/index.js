const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  // Replace this with your HTML content or read from a file
  const htmlContent = `
    <html>
    <body>
      <h1>Hello World!</h1>
      <p>This will be converted to PDF.</p>
    </body>
    </html>
  `;

  // Launch Puppeteer
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Set the HTML content
  await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

  // Save as PDF
  await page.pdf({ path: 'output.pdf', format: 'A4' });

  await browser.close();
  console.log('PDF generated: output.pdf');
})();
