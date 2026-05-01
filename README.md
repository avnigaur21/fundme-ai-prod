# FundMe AI Production

FundMe is an AI-powered platform that helps startup founders discover, apply to, and track funding opportunities, while enabling investors to explore ecosystem schemes, fund calls, and participation opportunities.

## Key Features

- **AI-Powered Matching**: Automatically matches your startup profile with relevant grants and funding opportunities.
- **Chrome Extension**: Scrape opportunities directly from the web and track applications in real-time.
- **Founder Dashboard**: Track the entire lifecycle of your applications from draft to submission.
- **Investor Module**: Explore ecosystem schemes, fund calls, and licensing pathways.
- **Automated Scrapers**: Built-in scrapers for major startup grant portals.

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/avnigaur21/fundme-ai-prod.git
   cd fundme-ai-prod
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up API keys:
   - Copy `key.example.txt` to `key.txt`
   - Add your [Groq](https://console.groq.com/) or [OpenRouter](https://openrouter.ai/) API keys.
   ```bash
   cp key.example.txt key.txt
   ```

### Running the Application

1. Start the server:
   ```bash
   npm start
   ```
   The server will run on `http://localhost:3000`.

2. Open `index.html` in your browser or navigate to `http://localhost:3000`.

## Chrome Extension Setup

1. Open Chrome and go to `chrome://extensions/`.
2. Enable "Developer mode".
3. Click "Load unpacked" and select the `chrome_extension` folder in this repository.

## Technology Stack

- **Backend**: Node.js, Express
- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **AI**: Groq (Llama 3), OpenRouter
- **Database**: Local JSON-based storage (data/db.json)

## License

This project is developed for educational and professional ecosystem support.
