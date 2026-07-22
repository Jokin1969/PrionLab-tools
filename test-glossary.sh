#!/bin/bash

# 🧪 Prueba de Regeneración de Resúmenes del Glosario
# Script para ejecutar desde el servidor sin necesidad de interfaz web

set -e

echo "🧪 Prueba de Regeneración de Resúmenes"
echo "========================================"
echo ""

# Detectar URL base
if [ -z "$PRIONLAB_URL" ]; then
    PRIONLAB_URL="${1:-http://localhost:5000}"
fi

echo "📍 URL: $PRIONLAB_URL"
echo ""

# Detectar número de artículos a probar
LIMIT="${2:-3}"
echo "📊 Regenerando los primeros $LIMIT artículos sin procesar..."
echo ""

# Hacer la llamada al API
RESPONSE=$(curl -s -X POST \
    "$PRIONLAB_URL/prionvault/api/glossary/test-regenerate-batch?limit=$LIMIT" \
    -H "Content-Type: application/json")

echo "📋 RESULTADO:"
echo "============="
echo ""

# Verificar si fue exitoso
if echo "$RESPONSE" | grep -q '"ok": true'; then
    echo "✅ PRUEBA COMPLETADA"
    echo ""

    # Extraer información
    GLOSSARY_VERSION=$(echo "$RESPONSE" | grep -o '"glossary_version": [0-9]*' | head -1 | cut -d: -f2 | tr -d ' ')
    TOTAL=$(echo "$RESPONSE" | grep -o '"total": [0-9]*' | head -1 | cut -d: -f2 | tr -d ' ')
    SUCCESSFUL=$(echo "$RESPONSE" | grep -o '"successful": [0-9]*' | head -1 | cut -d: -f2 | tr -d ' ')
    FAILED=$(echo "$RESPONSE" | grep -o '"failed": [0-9]*' | head -1 | cut -d: -f2 | tr -d ' ')

    echo "📌 Versión Glosario: $GLOSSARY_VERSION"
    echo "📊 Artículos: $TOTAL total"
    echo "✅ Exitosos: $SUCCESSFUL"
    echo "❌ Fallidos: $FAILED"
    echo ""

    # Mostrar resultados individuales
    echo "📄 Detalles por Artículo:"
    echo "------------------------"

    # Usar Python para parsear JSON (más confiable que grep)
    python3 - "$RESPONSE" << 'PYTHON'
import json
import sys

try:
    data = json.loads(sys.argv[1])
    for i, result in enumerate(data.get('results', []), 1):
        print(f"\n{i}. {result.get('title', 'N/A')[:60]}")
        print(f"   ID: {result.get('article_id', 'N/A')}")
        print(f"   Antes: {result.get('status_before', 'NULL')}")
        print(f"   Después: {result.get('status_after', 'NULL')}")

        if result.get('success'):
            print(f"   ✅ ÉXITO - Regenerado a versión {result.get('status_after')}")
            print(f"      Resumen: {result.get('summary_length', 0)} chars")
            print(f"      Modelo: {result.get('model', 'N/A')}")
            print(f"      Tokens: {result.get('tokens', 0)}")
        else:
            error = result.get('error', 'Unknown error')
            print(f"   ❌ FALLO")
            print(f"      Error: {error}")

    print("\n" + "="*50)
    print(f"📊 RESUMEN: {data.get('summary', 'N/A')}")
except Exception as e:
    print(f"Error parsing response: {e}")
    print(f"Response: {sys.argv[1]}")
PYTHON

    echo ""
    echo "✅ Prueba completada exitosamente"
    exit 0
else
    echo "❌ ERROR EN LA PRUEBA"
    echo ""
    echo "Respuesta del servidor:"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    exit 1
fi
