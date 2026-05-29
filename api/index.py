"""
Vercel Serverless Function wrapper for Flask backend.
This file imports the Flask app and exposes it for Vercel.
"""
import sys
import os

# Add backend directory to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from app import app

# Export the Flask app for Vercel
handler = app
