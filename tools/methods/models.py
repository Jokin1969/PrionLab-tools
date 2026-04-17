import csv
import logging
import os
import re

import pandas as pd

import config

logger = logging.getLogger(__name__)

CSV_DIR = config.CSV_DIR

METHODS_CATEGORIES_FILE    = os.path.join(CSV_DIR, "methods_categories.csv")
METHODS_SUBCATEGORIES_FILE = os.path.join(CSV_DIR, "methods_subcategories.csv")
METHODS_PROTOCOLS_FILE     = os.path.join(CSV_DIR, "methods_protocols.csv")
METHOD_PARAMETERS_FILE     = os.path.join(CSV_DIR, "method_parameters.csv")

METHODS_CATEGORIES_COLS    = ["category_id", "name", "description", "display_order"]
METHODS_SUBCATEGORIES_COLS = ["subcategory_id", "category_id", "name", "description", "display_order"]
METHODS_PROTOCOLS_COLS     = ["protocol_id", "subcategory_id", "title", "template_text", "is_active"]
METHOD_PARAMETERS_COLS     = ["parameter_id", "protocol_id", "name", "type", "default_value",
                               "options", "description", "display_order"]

# ── Seed data ─────────────────────────────────────────────────────────────────

_CATEGORIES_SEED = [
    ("cat_001", "Protein Production",    "Recombinant protein expression and purification", "1"),
    ("cat_002", "In Vitro Assays",       "Cell-free biochemical assays and amplification",  "2"),
    ("cat_003", "Animal Experiments",    "In vivo studies and bioassays",                   "3"),
    ("cat_004", "Biochemical Detection", "Western blot and enzymatic analysis",             "4"),
    ("cat_005", "Microscopy & Imaging",  "Electron microscopy and histology",               "5"),
]

_SUBCATEGORIES_SEED = [
    ("sub_001", "cat_001", "Expression",            "Bacterial expression systems",      "1"),
    ("sub_002", "cat_001", "Purification",           "Protein purification techniques",   "2"),
    ("sub_003", "cat_002", "Amplification",          "PMSA and PMCA protocols",           "1"),
    ("sub_004", "cat_002", "Enzyme Digestion",       "Protease treatments",               "2"),
    ("sub_005", "cat_003", "Inoculation",            "Animal inoculation procedures",     "1"),
    ("sub_006", "cat_003", "Monitoring",             "Clinical monitoring protocols",     "2"),
    ("sub_007", "cat_004", "Western Blot",           "Immunoblotting procedures",         "1"),
    ("sub_008", "cat_005", "Immunohistochemistry",   "IHC protocols",                     "1"),
]

_PROTOCOLS_SEED = [
    (
        "prot_001", "sub_001",
        "Recombinant PrP expression E. coli",
        (
            "Expression and purification of {protein_name} was carried out as described previously. "
            "The {protein_name} open reading frame was cloned into {vector} expression vector and "
            "transformed into E. coli {strain} competent cells. Bacteria were grown in LB broth with "
            "{antibiotic} at 37\u00b0C and recombinant protein expression was induced using {inducer} "
            "at {iptg_concentration} for {induction_time} hours. Purification was performed using "
            "{purification_method} taking advantage of the {tag_type} present in the protein."
        ),
        "true",
    ),
    (
        "prot_002", "sub_004",
        "PK digestion classical",
        (
            "Brain homogenates or cell lysates were subjected to proteinase K (PK) digestion prior to "
            "analysis. Samples were mixed 1:1 (v/v) with digestion buffer [2% (w/v) Tween-20, 2% (v/v) "
            "NP-40, and 5% (w/v) Sarkosyl in PBS]. PK was added to a final concentration of "
            "{pk_concentration} \u03bcg/ml and samples were incubated at {temperature}\u00b0C for "
            "{digestion_time} hour(s) with moderate shaking at {shaking_speed} rpm. Digestion was "
            "stopped by adding loading buffer and boiling samples for 10 min at 100\u00b0C."
        ),
        "true",
    ),
    (
        "prot_003", "sub_007",
        "Western blot standard",
        (
            "Western blot analysis was performed to detect protein levels. Samples were loaded onto "
            "{gel_type}% acrylamide gels and subjected to electrophoresis for approximately "
            "{electrophoresis_time} min. Proteins were transferred to {membrane_type} membranes using "
            "{transfer_method}. After blocking with {blocking_solution} for 1 h at room temperature, "
            "membranes were incubated overnight with primary antibody {antibody_name} ({antibody_dilution}) "
            "at 4\u00b0C. Following washing, membranes were incubated with {secondary_antibody} "
            "({secondary_dilution}) for 1 h at room temperature. Immunoreactive bands were visualized "
            "using {detection_substrate} and imaged with {imaging_system}."
        ),
        "true",
    ),
    (
        "prot_004", "sub_005",
        "Intracerebral inoculation",
        (
            "Mice aged {mouse_age} weeks were anesthetized using {anesthesia_method}. A small perforation "
            "was created in the right parietal bone, through which {inoculum_volume} \u03bcl of "
            "{inoculum_concentration}% brain homogenate was administered to the right cerebral hemisphere "
            "at approximately {injection_depth} mm depth using a sterile {needle_gauge}-gauge hypodermic "
            "needle. To prevent reflux, the needle remained in position for {wait_time} seconds before "
            "withdrawal. Animals received {analgesia} for post-operative pain management."
        ),
        "true",
    ),
    (
        "prot_005", "sub_008",
        "IHC PrPres detection",
        (
            "For immunohistochemical detection of PrPres, deparaffinized sections underwent epitope "
            "retrieval by immersion in {formic_acid_concentration}% formic acid for {formic_acid_time} "
            "min, followed by autoclaving in citrate buffer (pH {buffer_ph}) at 121\u00b0C for "
            "{autoclave_time} min. Sections were then digested with proteinase K ({pk_concentration_ihc} "
            "\u03bcg/ml) for {pk_time} min at 37\u00b0C. After blocking endogenous peroxidases and "
            "non-specific binding, sections were incubated overnight with anti-PrP monoclonal antibody "
            "{antibody_ihc} ({antibody_dilution_ihc}). Immunoreactivity was visualized using "
            "{detection_system_ihc} and {chromogen} as substrate."
        ),
        "true",
    ),
]

_PARAMETERS_SEED = [
    # prot_001
    ("param_001","prot_001","protein_name","text","bank vole PrP","","Name of the recombinant protein","1"),
    ("param_002","prot_001","vector","dropdown","pOPIN E","pOPIN E,pET28a,pET21a,pGEX-4T","Expression vector used","2"),
    ("param_003","prot_001","strain","dropdown","Rosetta\u2122 (DE3)","Rosetta\u2122 (DE3),BL21(DE3),DH5\u03b1,TOP10","E. coli strain used","3"),
    ("param_004","prot_001","antibiotic","dropdown","ampicillin","ampicillin,kanamycin,chloramphenicol","Selection antibiotic","4"),
    ("param_005","prot_001","inducer","text","IPTG","","Induction agent","5"),
    ("param_006","prot_001","iptg_concentration","dropdown","1 mM","0.1 mM,0.5 mM,1 mM,2 mM","IPTG concentration","6"),
    ("param_007","prot_001","induction_time","number","16","","Induction time in hours","7"),
    ("param_008","prot_001","purification_method","dropdown","histidine affinity chromatography","histidine affinity chromatography,glutathione affinity chromatography,ion exchange chromatography","Purification method","8"),
    ("param_009","prot_001","tag_type","dropdown","histidine residues","histidine residues,His-tag,GST-tag","Purification tag","9"),
    # prot_002
    ("param_010","prot_002","pk_concentration","dropdown","85","25,50,85,170","PK concentration in \u03bcg/ml","1"),
    ("param_011","prot_002","temperature","dropdown","42","37,42,56","Digestion temperature in \u00b0C","2"),
    ("param_012","prot_002","digestion_time","number","1","","Digestion time in hours","3"),
    ("param_013","prot_002","shaking_speed","number","450","","Shaking speed in rpm","4"),
    # prot_003
    ("param_014","prot_003","gel_type","dropdown","4-12","4-12,8-16,10,12,15","Acrylamide gel percentage","1"),
    ("param_015","prot_003","electrophoresis_time","number","80","","Electrophoresis time in minutes","2"),
    ("param_016","prot_003","membrane_type","dropdown","PVDF","PVDF,nitrocellulose","Transfer membrane type","3"),
    ("param_017","prot_003","transfer_method","dropdown","Trans-Blot Turbo","Trans-Blot Turbo,iBlot,wet transfer","Transfer method","4"),
    ("param_018","prot_003","blocking_solution","dropdown","5% non-fat milk","5% non-fat milk,5% BSA,commercial blocking buffer","Blocking solution","5"),
    ("param_019","prot_003","antibody_name","text","Sha31","","Primary antibody name","6"),
    ("param_020","prot_003","antibody_dilution","dropdown","1:4000","1:1000,1:2000,1:4000,1:5000","Primary antibody dilution","7"),
    ("param_021","prot_003","secondary_antibody","dropdown","anti-mouse HRP","anti-mouse HRP,anti-rabbit HRP,anti-human HRP","Secondary antibody","8"),
    ("param_022","prot_003","secondary_dilution","dropdown","1:5000","1:3000,1:5000,1:10000","Secondary antibody dilution","9"),
    ("param_023","prot_003","detection_substrate","dropdown","ECL","ECL,DAB,TMB","Detection substrate","10"),
    ("param_024","prot_003","imaging_system","dropdown","iBright CL750","iBright CL750,FluorChem Q,ChemiDoc","Imaging system","11"),
    # prot_004
    ("param_025","prot_004","mouse_age","dropdown","6-8","4-6,6-8,8-12","Mouse age range in weeks","1"),
    ("param_026","prot_004","anesthesia_method","dropdown","isoflurane","isoflurane,ketamine/medetomidine","Anesthesia method","2"),
    ("param_027","prot_004","inoculum_volume","number","20","","Inoculum volume in \u03bcl","3"),
    ("param_028","prot_004","inoculum_concentration","number","1","","Brain homogenate concentration in %","4"),
    ("param_029","prot_004","injection_depth","number","3","","Injection depth in mm","5"),
    ("param_030","prot_004","needle_gauge","number","27","","Needle gauge","6"),
    ("param_031","prot_004","wait_time","number","20","","Wait time before needle withdrawal in seconds","7"),
    ("param_032","prot_004","analgesia","dropdown","buprenorphine (0.3 mg/kg)","buprenorphine (0.3 mg/kg),carprofen (5 mg/kg)","Post-operative analgesia","8"),
    # prot_005
    ("param_033","prot_005","formic_acid_concentration","number","98","","Formic acid concentration in %","1"),
    ("param_034","prot_005","formic_acid_time","number","15","","Formic acid treatment time in minutes","2"),
    ("param_035","prot_005","buffer_ph","number","6.15","","Citrate buffer pH","3"),
    ("param_036","prot_005","autoclave_time","number","20","","Autoclave time in minutes","4"),
    ("param_037","prot_005","pk_concentration_ihc","number","4","","PK concentration for IHC in \u03bcg/ml","5"),
    ("param_038","prot_005","pk_time","number","15","","PK digestion time in minutes","6"),
    ("param_039","prot_005","antibody_ihc","dropdown","6C2","6C2,2G11,Sha31","Primary antibody for IHC","7"),
    ("param_040","prot_005","antibody_dilution_ihc","dropdown","1:1000","1:500,1:1000,1:2000","Primary antibody dilution for IHC","8"),
    ("param_041","prot_005","detection_system_ihc","dropdown","EnVision system","EnVision system,ABC kit,polymer system","Detection system for IHC","9"),
    ("param_042","prot_005","chromogen","dropdown","DAB","DAB,AEC,NovaRED","Chromogenic substrate","10"),
]


# ── Internal helpers ──────────────────────────────────────────────────────────

def _read(filepath: str, columns: list[str]) -> pd.DataFrame:
    if not os.path.exists(filepath):
        return pd.DataFrame(columns=columns)
    try:
        df = pd.read_csv(filepath, dtype=str, keep_default_na=False, na_values=[])
        for col in columns:
            if col not in df.columns:
                df[col] = ""
        return df[columns]
    except Exception as e:
        logger.error("Failed to read %s: %s", filepath, e)
        return pd.DataFrame(columns=columns)


def _write(df: pd.DataFrame, filepath: str) -> None:
    os.makedirs(CSV_DIR, exist_ok=True)
    df.to_csv(filepath, index=False, quoting=csv.QUOTE_ALL)


# ── Seed functions ────────────────────────────────────────────────────────────

def _seed_methods_categories_if_empty() -> None:
    df = _read(METHODS_CATEGORIES_FILE, METHODS_CATEGORIES_COLS)
    if not df.empty:
        return
    rows = [dict(zip(METHODS_CATEGORIES_COLS, row)) for row in _CATEGORIES_SEED]
    _write(pd.DataFrame(rows, columns=METHODS_CATEGORIES_COLS), METHODS_CATEGORIES_FILE)
    logger.info("Seeded %d methods categories", len(rows))


def _seed_methods_subcategories_if_empty() -> None:
    df = _read(METHODS_SUBCATEGORIES_FILE, METHODS_SUBCATEGORIES_COLS)
    if not df.empty:
        return
    rows = [dict(zip(METHODS_SUBCATEGORIES_COLS, row)) for row in _SUBCATEGORIES_SEED]
    _write(pd.DataFrame(rows, columns=METHODS_SUBCATEGORIES_COLS), METHODS_SUBCATEGORIES_FILE)
    logger.info("Seeded %d methods subcategories", len(rows))


def _seed_methods_protocols_if_empty() -> None:
    df = _read(METHODS_PROTOCOLS_FILE, METHODS_PROTOCOLS_COLS)
    if not df.empty:
        return
    rows = [dict(zip(METHODS_PROTOCOLS_COLS, row)) for row in _PROTOCOLS_SEED]
    _write(pd.DataFrame(rows, columns=METHODS_PROTOCOLS_COLS), METHODS_PROTOCOLS_FILE)
    logger.info("Seeded %d methods protocols", len(rows))


def _seed_method_parameters_if_empty() -> None:
    df = _read(METHOD_PARAMETERS_FILE, METHOD_PARAMETERS_COLS)
    if not df.empty:
        return
    rows = [dict(zip(METHOD_PARAMETERS_COLS, row)) for row in _PARAMETERS_SEED]
    _write(pd.DataFrame(rows, columns=METHOD_PARAMETERS_COLS), METHOD_PARAMETERS_FILE)
    logger.info("Seeded %d method parameters", len(rows))


def bootstrap_methods_schema() -> None:
    _seed_methods_categories_if_empty()
    _seed_methods_subcategories_if_empty()
    _seed_methods_protocols_if_empty()
    _seed_method_parameters_if_empty()


# ── Public API ────────────────────────────────────────────────────────────────

def build_protocols_data() -> dict:
    cats_df  = _read(METHODS_CATEGORIES_FILE,    METHODS_CATEGORIES_COLS)
    subs_df  = _read(METHODS_SUBCATEGORIES_FILE,  METHODS_SUBCATEGORIES_COLS)
    prots_df = _read(METHODS_PROTOCOLS_FILE,      METHODS_PROTOCOLS_COLS)
    params_df = _read(METHOD_PARAMETERS_FILE,     METHOD_PARAMETERS_COLS)

    categories = []
    for _, cat in cats_df.sort_values("display_order").iterrows():
        cat_subs = subs_df[subs_df["category_id"] == cat["category_id"]].sort_values("display_order")
        subcats = []
        for _, sub in cat_subs.iterrows():
            sub_prots = prots_df[
                (prots_df["subcategory_id"] == sub["subcategory_id"]) &
                (prots_df["is_active"] == "true")
            ]
            protocols = []
            for _, prot in sub_prots.iterrows():
                prot_params = params_df[
                    params_df["protocol_id"] == prot["protocol_id"]
                ].sort_values("display_order")
                params = []
                for _, param in prot_params.iterrows():
                    raw_opts = str(param.get("options", "") or "").strip()
                    opts = (
                        [o.strip() for o in raw_opts.split(",") if o.strip()]
                        if raw_opts and raw_opts.lower() != "null"
                        else None
                    )
                    params.append({
                        "name":          param["name"],
                        "type":          param["type"],
                        "default_value": param["default_value"],
                        "options":       opts,
                        "description":   param["description"],
                    })
                protocols.append({
                    "protocol_id":   prot["protocol_id"],
                    "title":         prot["title"],
                    "template_text": prot["template_text"],
                    "parameters":    params,
                })
            if protocols:
                subcats.append({
                    "subcategory_id": sub["subcategory_id"],
                    "name":           sub["name"],
                    "protocols":      protocols,
                })
        if subcats:
            categories.append({
                "category_id": cat["category_id"],
                "name":        cat["name"],
                "description": cat["description"],
                "subcategories": subcats,
            })

    return {"categories": categories}


def generate_protocol_text(protocol_id: str, parameters: dict) -> dict:
    df = _read(METHODS_PROTOCOLS_FILE, METHODS_PROTOCOLS_COLS)
    row = df[df["protocol_id"] == protocol_id]
    if row.empty:
        raise ValueError(f"Unknown protocol: {protocol_id}")

    template = row.iloc[0]["template_text"]
    text = re.sub(
        r"\{(\w+)\}",
        lambda m: str(parameters.get(m.group(1), "{" + m.group(1) + "}")),
        template,
    )
    return {
        "protocol_text": text,
        "protocol_id":   protocol_id,
        "warnings":      validate_parameters(protocol_id, parameters),
    }


def combine_protocols(protocol_texts: list[str]) -> str:
    return "\n\n".join(t.strip() for t in protocol_texts if t.strip())


def validate_parameters(protocol_id: str, parameters: dict) -> list[str]:
    warnings: list[str] = []

    if protocol_id == "prot_002":
        try:
            pk_conc = float(parameters.get("pk_concentration", 85))
            temp    = float(parameters.get("temperature", 42))
            if pk_conc > 100 and temp > 45:
                warnings.append(
                    "High PK concentration with high temperature may over-digest proteins."
                )
        except (ValueError, TypeError):
            pass

    return warnings
