// analyze.js
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

class SimpleTikTokAnalyzer {
  constructor() {
    this.username = process.env.TIKTOK_USERNAME;
    this.dataDir = './data';
    this.csvFile = path.join(this.dataDir, 'tiktok-analytics.csv');
    
    // データディレクトリ作成
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  async scrapeProfileData() {
    let browser;
    try {
      console.log('Launching browser...');
      
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });

      const page = await browser.newPage();
      
      // TikTokプロフィールページにアクセス
      const url = `https://www.tiktok.com/@${this.username}`;
      console.log(`Accessing: ${url}`);
      
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      
      // ページが読み込まれるまで少し待機
      await page.waitForTimeout(3000);

      // プロフィール情報を取得
      const profileData = await page.evaluate(() => {
        const getText = (selector) => {
          const element = document.querySelector(selector);
          return element ? element.textContent.trim() : '0';
        };

        // 数字を正規化（1.2M → 1200000 など）
        const parseNumber = (text) => {
          if (!text) return 0;
          text = text.toLowerCase().replace(/[,\s]/g, '');
          
          if (text.includes('k')) {
            return Math.round(parseFloat(text) * 1000);
          } else if (text.includes('m')) {
            return Math.round(parseFloat(text) * 1000000);
          } else {
            return parseInt(text) || 0;
          }
        };

        // フォロワー数、フォロー中、いいね数を取得
        const followersText = getText('[data-e2e="followers-count"]') || 
                             getText('[title*="Followers"]') ||
                             getText('strong[title*="Followers"]');
        
        const followingText = getText('[data-e2e="following-count"]') ||
                             getText('[title*="Following"]') ||
                             getText('strong[title*="Following"]');
        
        const likesText = getText('[data-e2e="likes-count"]') ||
                         getText('[title*="Likes"]') ||
                         getText('strong[title*="Likes"]');

        // 最新の動画のエンゲージメントも取得
        const firstVideo = document.querySelector('[data-e2e="user-post-item"]');
        let firstVideoViews = 0;
        if (firstVideo) {
          const viewsElement = firstVideo.querySelector('[data-e2e="video-views"]') ||
                              firstVideo.querySelector('strong');
          if (viewsElement) {
            firstVideoViews = parseNumber(viewsElement.textContent);
          }
        }

        return {
          followers: parseNumber(followersText),
          following: parseNumber(followingText),
          likes: parseNumber(likesText),
          latestVideoViews: firstVideoViews,
          timestamp: new Date().toISOString()
        };
      });

      console.log('Scraped data:', profileData);
      return profileData;

    } catch (error) {
      console.error('Scraping error:', error);
      return null;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  saveData(data) {
    const today = new Date().toISOString().split('T')[0];
    
    // CSV形式でデータを保存
    const csvRow = `${today},${data.followers},${data.following},${data.likes},${data.latestVideoViews}\n`;
    
    // ヘッダーがない場合は追加
    if (!fs.existsSync(this.csvFile)) {
      const header = 'date,followers,following,likes,latest_video_views\n';
      fs.writeFileSync(this.csvFile, header);
    }
    
    fs.appendFileSync(this.csvFile, csvRow);
    console.log('Data saved to CSV');
  }

  loadHistoricalData() {
    if (!fs.existsSync(this.csvFile)) {
      return [];
    }

    const csvData = fs.readFileSync(this.csvFile, 'utf8');
    const lines = csvData.trim().split('\n').slice(1); // ヘッダーを除く
    
    return lines.map(line => {
      const [date, followers, following, likes, latestVideoViews] = line.split(',');
      return {
        date,
        followers: parseInt(followers),
        following: parseInt(following),
        likes: parseInt(likes),
        latestVideoViews: parseInt(latestVideoViews)
      };
    });
  }

  analyzeData(currentData) {
    const historical = this.loadHistoricalData();
    
    if (historical.length === 0) {
      return {
        isFirstRun: true,
        message: 'データ収集を開始しました！明日から比較分析が利用できます。'
      };
    }

    const yesterday = historical[historical.length - 1];
    const weekAgo = historical.length >= 7 ? historical[historical.length - 7] : yesterday;

    const analysis = {
      isFirstRun: false,
      daily: {
        followers: currentData.followers - yesterday.followers,
        following: currentData.following - yesterday.following,
        likes: currentData.likes - yesterday.likes,
        latestVideoViews: currentData.latestVideoViews
      },
      weekly: {
        followers: currentData.followers - weekAgo.followers,
        following: currentData.following - weekAgo.following,
        likes: currentData.likes - weekAgo.likes
      },
      current: currentData,
      trends: this.calculateTrends(historical, currentData)
    };

    return analysis;
  }

  calculateTrends(historical, current) {
    if (historical.length < 7) return { message: 'トレンド分析には1週間のデータが必要です' };

    const recentWeek = historical.slice(-7);
    const avgFollowerGrowth = recentWeek.reduce((sum, day, idx) => {
      if (idx === 0) return 0;
      return sum + (day.followers - recentWeek[idx - 1].followers);
    }, 0) / 6;

    const avgLikeGrowth = recentWeek.reduce((sum, day, idx) => {
      if (idx === 0) return 0;
      return sum + (day.likes - recentWeek[idx - 1].likes);
    }, 0) / 6;

    return {
      avgDailyFollowerGrowth: Math.round(avgFollowerGrowth),
      avgDailyLikeGrowth: Math.round(avgLikeGrowth),
      growthTrend: avgFollowerGrowth > 0 ? '上昇傾向' : avgFollowerGrowth < 0 ? '下降傾向' : '横ばい'
    };
  }

  async sendEmail(analysis) {
    try {
      const transporter = nodemailer.createTransporter({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });

      const emailContent = this.generateEmailContent(analysis);

      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: `TikTok分析レポート - ${new Date().toLocaleDateString('ja-JP')}`,
        html: emailContent
      });

      console.log('Email sent successfully');
    } catch (error) {
      console.error('Email error:', error);
    }
  }

  generateEmailContent(analysis) {
    if (analysis.isFirstRun) {
      return `
        <h2>📊 TikTok分析システム開始！</h2>
        <p>${analysis.message}</p>
        <p>現在のデータ:</p>
        <ul>
          <li>フォロワー数: ${analysis.current?.followers?.toLocaleString() || 'N/A'}</li>
          <li>フォロー中: ${analysis.current?.following?.toLocaleString() || 'N/A'}</li>
          <li>いいね数: ${analysis.current?.likes?.toLocaleString() || 'N/A'}</li>
        </ul>
      `;
    }

    const { daily, weekly, current, trends } = analysis;

    const formatChange = (value) => {
      if (value > 0) return `<span style="color: green;">+${value.toLocaleString()}</span>`;
      if (value < 0) return `<span style="color: red;">${value.toLocaleString()}</span>`;
      return `<span style="color: gray;">±0</span>`;
    };

    return `
      <h2>📊 TikTok日次分析レポート</h2>
      <p><strong>日付:</strong> ${new Date().toLocaleDateString('ja-JP')}</p>
      
      <h3>📈 現在の数値</h3>
      <ul>
        <li><strong>フォロワー数:</strong> ${current.followers.toLocaleString()}</li>
        <li><strong>フォロー中:</strong> ${current.following.toLocaleString()}</li>
        <li><strong>総いいね数:</strong> ${current.likes.toLocaleString()}</li>
        <li><strong>最新動画再生数:</strong> ${current.latestVideoViews.toLocaleString()}</li>
      </ul>

      <h3>📊 昨日からの変化</h3>
      <ul>
        <li><strong>フォロワー:</strong> ${formatChange(daily.followers)}</li>
        <li><strong>フォロー:</strong> ${formatChange(daily.following)}</li>
        <li><strong>いいね:</strong> ${formatChange(daily.likes)}</li>
      </ul>

      <h3>📅 1週間の変化</h3>
      <ul>
        <li><strong>フォロワー:</strong> ${formatChange(weekly.followers)}</li>
        <li><strong>フォロー:</strong> ${formatChange(weekly.following)}</li>
        <li><strong>いいね:</strong> ${formatChange(weekly.likes)}</li>
      </ul>

      ${trends.avgDailyFollowerGrowth !== undefined ? `
      <h3>🔮 トレンド分析</h3>
      <ul>
        <li><strong>平均日次フォロワー増加:</strong> ${trends.avgDailyFollowerGrowth}</li>
        <li><strong>平均日次いいね増加:</strong> ${trends.avgDailyLikeGrowth}</li>
        <li><strong>成長トレンド:</strong> ${trends.growthTrend}</li>
      </ul>
      ` : ''}

      <hr>
      <p><small>TikTok Analytics System - GitHub Actions で自動生成</small></p>
    `;
  }

  async run() {
    try {
      console.log('Starting TikTok analysis...');
      
      if (!this.username) {
        throw new Error('TIKTOK_USERNAME not set');
      }

      // データを取得
      const currentData = await this.scrapeProfileData();
      
      if (!currentData) {
        throw new Error('Failed to scrape profile data');
      }

      // データを保存
      this.saveData(currentData);

      // 分析実行
      const analysis = this.analyzeData(currentData);

      // メール送信
      await this.sendEmail(analysis);

      console.log('Analysis completed successfully!');
      
    } catch (error) {
      console.error('Analysis failed:', error);
      
      // エラー時もメール送信
      try {
        const transporter = nodemailer.createTransporter({
          service: 'gmail',
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
          }
        });

        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: process.env.EMAIL_USER,
          subject: 'TikTok分析エラー',
          text: `分析中にエラーが発生しました: ${error.message}`
        });
      } catch (emailError) {
        console.error('Failed to send error email:', emailError);
      }
    }
  }
}

// 実行
const analyzer = new SimpleTikTokAnalyzer();
analyzer.run();
