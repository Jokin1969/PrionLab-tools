"""Claude API pricing and cost calculation.

Current pricing (as of Feb 2025):
- Haiku 3.5: $0.80 / 1M input, $4.00 / 1M output
- Haiku 4.5: $0.80 / 1M input, $4.00 / 1M output (estimated similar)
- Sonnet: $3.00 / 1M input, $15.00 / 1M output
"""
import logging

logger = logging.getLogger(__name__)

# Model pricing in USD per 1M tokens
PRICING = {
    "claude-haiku-3-5-20241022": {
        "input": 0.80,
        "output": 4.00,
        "display_name": "Claude Haiku 3.5",
    },
    "claude-haiku-4-5-20251001": {
        "input": 0.80,
        "output": 4.00,
        "display_name": "Claude Haiku 4.5",
    },
    "claude-sonnet-4-20250514": {
        "input": 3.00,
        "output": 15.00,
        "display_name": "Claude Sonnet",
    },
    "claude-opus-4-1": {
        "input": 15.00,
        "output": 75.00,
        "display_name": "Claude Opus",
    },
}

# EUR/USD exchange rate (approximate, can update)
# Update this periodically or fetch from API
EUR_USD_RATE = 1.10  # 1 EUR = 1.10 USD


def calculate_cost(
    input_tokens: int,
    output_tokens: int,
    model: str = "claude-haiku-4-5-20251001"
) -> dict:
    """Calculate cost for API usage.

    Args:
        input_tokens: Number of input tokens used
        output_tokens: Number of output tokens used
        model: Model identifier (defaults to Haiku 4.5)

    Returns:
        {
            "model": "Claude Haiku 4.5",
            "input_tokens": 1234,
            "output_tokens": 567,
            "total_tokens": 1801,
            "cost_usd": 0.00567,
            "cost_eur": 0.00515,
            "input_cost_usd": 0.001,
            "output_cost_usd": 0.00267,
        }
    """
    model_info = PRICING.get(model, PRICING["claude-haiku-4-5-20251001"])

    input_cost = (input_tokens / 1_000_000) * model_info["input"]
    output_cost = (output_tokens / 1_000_000) * model_info["output"]
    total_cost_usd = input_cost + output_cost
    total_cost_eur = total_cost_usd / EUR_USD_RATE

    return {
        "model": model_info["display_name"],
        "model_id": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "cost_usd": round(total_cost_usd, 6),
        "cost_eur": round(total_cost_eur, 6),
        "input_cost_usd": round(input_cost, 6),
        "output_cost_usd": round(output_cost, 6),
    }


def calculate_batch_cost(
    batch_results: dict,
    model: str = "claude-haiku-4-5-20251001"
) -> dict:
    """Calculate total cost for a batch improvement.

    Args:
        batch_results: Dict with token info for each article
        model: Model identifier

    Returns:
        {
            "total_tokens": 50000,
            "total_input_tokens": 40000,
            "total_output_tokens": 10000,
            "cost_usd": 0.045,
            "cost_eur": 0.041,
            "model": "Claude Haiku 4.5",
            "avg_tokens_per_article": 150,
            "articles_processed": 333,
        }
    """
    model_info = PRICING.get(model, PRICING["claude-haiku-4-5-20251001"])

    # Extract from batch_results dict - may have article_tokens list
    articles_processed = batch_results.get("successful", 0)
    total_input_tokens = batch_results.get("total_input_tokens", 0)
    total_output_tokens = batch_results.get("total_output_tokens", 0)
    total_tokens = total_input_tokens + total_output_tokens

    input_cost = (total_input_tokens / 1_000_000) * model_info["input"]
    output_cost = (total_output_tokens / 1_000_000) * model_info["output"]
    total_cost_usd = input_cost + output_cost
    total_cost_eur = total_cost_usd / EUR_USD_RATE

    avg_tokens = total_tokens // articles_processed if articles_processed > 0 else 0

    return {
        "model": model_info["display_name"],
        "model_id": model,
        "total_tokens": total_tokens,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "articles_processed": articles_processed,
        "cost_usd": round(total_cost_usd, 4),
        "cost_eur": round(total_cost_eur, 4),
        "input_cost_usd": round(input_cost, 4),
        "output_cost_usd": round(output_cost, 4),
        "avg_tokens_per_article": avg_tokens,
    }


def format_cost_summary(cost_info: dict) -> str:
    """Format cost info as human-readable string.

    Example: "50,000 tokens (€0.04 / $0.05) - Claude Haiku 4.5"
    """
    return (
        f"{cost_info['total_tokens']:,} tokens "
        f"(€{cost_info['cost_eur']:.2f} / ${cost_info['cost_usd']:.2f}) "
        f"- {cost_info['model']}"
    )
