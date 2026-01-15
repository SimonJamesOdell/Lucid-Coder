// Flask template generators
export default {
  python: {
    requirementsTxt: `Flask==3.0.0
    flask-cors==4.0.0
    python-dotenv==1.0.0

    # Testing & coverage
    pytest==8.2.2
    pytest-cov==5.0.0`,
    appPy: (name) => `from flask import Flask, jsonify
from flask_cors import CORS
from datetime import datetime
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

@app.route('/api/health')
def health():
    return jsonify({
        'message': 'Backend is running successfully!',
        'project': '${name}',
        'timestamp': datetime.now().isoformat()
    })

@app.route('/api')
def api():
    return jsonify({'message': 'Welcome to ${name} API'})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)`,
    pytestIni: `[pytest]
markers =
  e2e: end-to-end tests
addopts = -q
`,
    testAppPy: (name) => `import pytest

from app import app


@pytest.fixture()
def client():
  app.testing = True
  with app.test_client() as client:
    yield client


def test_health_endpoint(client):
  response = client.get('/api/health')
  assert response.status_code == 200
  data = response.get_json()
  assert data['message'] == 'Backend is running successfully!'
  assert data['project'] == '${name}'


@pytest.mark.e2e
def test_e2e_api_root(client):
  response = client.get('/api')
  assert response.status_code == 200
  data = response.get_json()
  assert 'message' in data
`,
    envExample: `PORT=5000
FLASK_ENV=development`
  }
}
