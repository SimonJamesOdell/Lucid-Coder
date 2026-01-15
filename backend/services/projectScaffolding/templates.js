// Template generators for different frameworks
import react from './templates/frontend/react.js';
import vue from './templates/frontend/vue.js';
import express from './templates/backend/express.js';
import flask from './templates/backend/flask.js';

export const templates = {
  frontend: {
    react,
    vue
  },
  backend: {
    express,
    flask
  }
};
