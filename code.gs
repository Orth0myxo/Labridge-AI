// =========================================================================
// LABBRIDGE AI - FINAL COMPREHENSIVE PRODUCTION ENGINE & SURVEILLANCE HUB
// =========================================================================

const GEMINI_API_KEY = 'API_KEY_HERE'; 
const API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;
const ARCHIVE_SPREADSHEET_ID = '1C3tVrgQJACFxkO8hZh3xX0HZCAuHrTSmTblHlwgCM2I';

function generateLabBridgeSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = ss.getSheetByName("Active_Patients");
  if (!activeSheet) return;
  
  const lastRow = activeSheet.getLastRow();
  if (lastRow < 2) return; 
  
  for (let i = 2; i <= lastRow; i++) {
    const targetLanguage = activeSheet.getRange(i, 5).getValue().toString().trim();
    const statusCell = activeSheet.getRange(i, 8); // Column H
    const existingSummary = statusCell.getValue().toString().trim();
    
    if (targetLanguage === "" || (existingSummary !== "" && !existingSummary.startsWith("Error") && !existingSummary.startsWith("Connection") && !existingSummary.startsWith("[CRITICAL"))) {
      continue; 
    }
    
    statusCell.setValue("Processing in " + targetLanguage + "...");
    SpreadsheetApp.flush();
    
    const patientId = activeSheet.getRange(i, 1).getValue().toString().trim();
    const testName = activeSheet.getRange(i, 2).getValue().toString().trim();
    const valueStr = activeSheet.getRange(i, 3).getValue().toString().trim();
    const rawValue = parseFloat(valueStr);
    const refRangeStr = activeSheet.getRange(i, 4).getValue().toString().trim();
    const testDate = activeSheet.getRange(i, 6).getValue();
    const lgaLocation = activeSheet.getRange(i, 7).getValue().toString().trim();
    
    if (!testName || !valueStr) continue;

    // 1. NCDC CLINICAL TONE EVALUATION
    let toneGuidance = "The result is perfectly normal and healthy. Keep the tone completely relaxed, casual, and happy. The advice to see a doctor should be a very soft, optional recommendation just for routine tracking.";
    let rangeMatch = refRangeStr.match(/([\d.]+)\s*-\s*([\d.]+)/); 
    
    if (rangeMatch && !isNaN(rawValue)) {
      let lowerBound = parseFloat(rangeMatch[1]);
      let upperBound = parseFloat(rangeMatch[2]);
      if (rawValue < lowerBound || rawValue > upperBound) {
        toneGuidance = "The result is slightly outside the standard baseline. Keep the tone warm, calm, and reassuring. Do not create panic or use words like emergency or sharp sharp. Frame the advice to see a doctor as a routine, friendly next step.";
      }
    } else if (refRangeStr.toUpperCase().includes("SIGNIFICANT TITRE") && !isNaN(rawValue) && rawValue >= 80) {
      toneGuidance = "The result shows an active clinical marker. Keep the tone supportive and clear. Advise them to share it with their doctor for proper management, but do not use scary or alarmist language.";
    }

    // 2. RUN SEMANTIC AI INTERPRETATION
    const prompt = `You are LabBridge AI. Translate this laboratory result into a direct, zero-fluff patient summary.
TONE RULES: ${toneGuidance}
CRITICAL INSTRUCTIONS:
1. Write entirely in ${targetLanguage}. Do not mix with English.
2. Keep it incredibly brief (exactly 2 to 3 short sentences total). No fluff.
3. No hyphens, dashes, bullet points, or line breaks. Continuous block text only.
4. Do not state raw numbers, prescriptions, or reference intervals back to the patient.

Structure:
- Step 1: State what the test result indicates simply.
- Step 2: State what that immediately means for their body.
- Step 3: Friendly, calm closing advice to share this with their doctor. Stop talking immediately after this.`;

    const payload = { "contents": [{ "parts": [{ "text": prompt + `\nTest: ${testName}\nValue: ${valueStr}\nRange: ${refRangeStr}` }] }] };
    const options = { "method": "post", "contentType": "application/json", "payload": JSON.stringify(payload), "muteHttpExceptions": true };
    
    try {
      const response = UrlFetchApp.fetch(API_URL, options);
      if (response.getResponseCode() === 200) {
        const aiOutput = JSON.parse(response.getContentText()).candidates[0].content.parts[0].text;
        
        if (postGenerationValidator(aiOutput)) {
          statusCell.setValue(aiOutput);
          SpreadsheetApp.flush();
          
          // Route data directly to the background Warehouse
          pushToCentralWarehouse(patientId, testName, valueStr, refRangeStr, targetLanguage, testDate, lgaLocation, aiOutput);
        } else {
          statusCell.setValue("[CRITICAL ERROR: Safety/Length Validation Failed.]");
        }
      } else {
        statusCell.setValue("Error: " + JSON.parse(response.getContentText()).error.message);
      }
    } catch (e) {
      statusCell.setValue("Connection Error: " + e.toString());
    }
    Utilities.sleep(1000); 
  }
  
  // Refresh real-time dashboard analytics
  generateLabUnitAnalytics();
}

function postGenerationValidator(text) {
  if (!text) return false;
  if (text.split('\n').filter(l => l.trim() !== "").length > 3) return false; 
  const forbidden = ["ciprofloxacin", "amoxicillin", "paracetamol", "panadol", "flagyl", "metronidazole", "antibiotic", "artemether"];
  let lower = text.toLowerCase();
  for (let drug of forbidden) { if (lower.includes(drug)) return false; }
  return true;
}

function pushToCentralWarehouse(id, test, val, ref, lang, date, lga, summary) {
  try {
    const archiveFile = SpreadsheetApp.openById(ARCHIVE_SPREADSHEET_ID);
    let targetTabName = "Archive_ChemPath"; 
    
    let testUpper = test.toUpperCase();
    if (testUpper.includes("COUNT") || testUpper.includes("BLOOD") || testUpper.includes("PCV") || testUpper.includes("ESR") || testUpper.includes("HEMA")) {
      targetTabName = "Archive_Hematology";
    } else if (testUpper.includes("CULTURE") || testUpper.includes("URINE") || testUpper.includes("MALARIA") || testUpper.includes("SMEAR") || testUpper.includes("TITRE") || testUpper.includes("WIDAL")) {
      targetTabName = "Archive_Microbiology";
    }
    
    let targetTab = archiveFile.getSheetByName(targetTabName);
    if (targetTab) {
      targetTab.appendRow([id, test, val, ref, lang, date, lga, summary, new Date()]);
    }
  } catch(e) {
    Logger.log("Warehouse Routing Error: " + e.toString());
  }
}

// =========================================================================
// ADVANCED QUANTITATIVE EPIDEMIOLOGY & INVENTORY ANALYTICS ENGINE
// =========================================================================
function generateLabUnitAnalytics() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let mainSheet = ss.getSheetByName("Active_Patients");
  let analyticsSheet = ss.getSheetByName("LabBridge_Analytics");
  if (!analyticsSheet || !mainSheet) return;
  
  let maxInventoryRows = analyticsSheet.getLastRow();
  let inventoryMap = {};
  
  if (maxInventoryRows >= 4) {
    let manualStockData = analyticsSheet.getRange(4, 7, maxInventoryRows - 3, 2).getValues();
    for (let i = 0; i < manualStockData.length; i++) {
      let profileKey = manualStockData[i][0].toString().trim().toUpperCase();
      let stockValue = parseFloat(manualStockData[i][1]);
      if (profileKey !== "" && !isNaN(stockValue)) {
        inventoryMap[profileKey] = stockValue;
      }
    }
  }
  
  analyticsSheet.clear();
  analyticsSheet.getRange("A1").setValue("LABBRIDGE MANAGEMENT METRICS HUB").setFontWeight("bold").setFontSize(14);
  analyticsSheet.getRange("A3:E3").setValues([[
    "Standardized Test Profile", 
    "Total Vol. (Current Week)", 
    "Current Stock Balance",
    "Reagent Supply Status", 
    "NCDC Epidemiological Status"
  ]]).setFontWeight("bold").setBackground("#e2e8f0");
  
  analyticsSheet.getRange("G3:H3").setValues([[
    "Tracked Profile (Manual Input)", 
    "Total Kit Capacity Added"
  ]]).setFontWeight("bold").setBackground("#cbd5e1");
  
  const lastRow = mainSheet.getLastRow();
  if (lastRow < 2) return;
  
  let rowsData = mainSheet.getRange(2, 2, lastRow - 1, 6).getValues(); // Columns B to G
  let metricsMap = {};
  let lgaDistribution = {};
  
  function normalizeTestName(name) {
    let clean = name.toString().trim().toUpperCase();
    if (clean === "PCV" || clean.includes("PACKED CELL")) return "PACKED CELL VOLUME (PCV)";
    if (clean === "MP" || clean.includes("MALARIA") || clean.includes("PARASITE")) return "MALARIA PARASITE (MP)";
    if (clean === "FBC" || clean.includes("FULL BLOOD") || clean.includes("CBC")) return "FULL BLOOD COUNT (FBC)";
    if (clean === "WIDAL" || clean.includes("TYPHOID")) return "WIDAL SALMONELLA TYPHI AGGLUTINATION";
    if (clean === "FBS" || clean.includes("FASTING BLOOD")) return "FASTING BLOOD SUGAR (FBS)";
    if (clean === "RBS" || clean.includes("RANDOM BLOOD")) return "RANDOM BLOOD SUGAR (RBS)";
    return clean;
  }
  
  // Aggregate data dynamically by Profile and geographic location
  for (let i = 0; i < rowsData.length; i++) {
    let rawName = rowsData[i][0];
    let lga = rowsData[i][5].toString().trim().toUpperCase();
    let normalized = normalizeTestName(rawName);
    if (normalized === "") continue;
    
    metricsMap[normalized] = (metricsMap[normalized] || 0) + 1;
    
    if (lga !== "") {
      if (!lgaDistribution[normalized]) lgaDistribution[normalized] = {};
      lgaDistribution[normalized][lga] = (lgaDistribution[normalized][lga] || 0) + 1;
    }
  }
  
  let outputRow = 4;
  
  // HARDCODED NCDC BASELINE ASSUMPTIONS FOR VIVA DEMO
  // In a live system, this calculates against historical weeks
  const HISTORICAL_WEEKLY_BASELINE_AVG = 8; 
  
  for (let profile in metricsMap) {
    let currentWeekCount = metricsMap[profile];
    let initialStock = inventoryMap[profile] || 0;
    let currentBalance = initialStock - currentWeekCount;
    if (currentBalance < 0) currentBalance = 0;
    
    // Column 4: Supply Logic Matrix
    let supplyStatus = "SUFFICIENT STOCK";
    if (initialStock === 0) supplyStatus = "NO BASELINE STOCK ENTRY FOUND";
    else if (currentBalance === 0) supplyStatus = "📦 REAGENT COMPLETELY DEPLETED";
    else if (currentBalance <= 10) supplyStatus = "CRITICAL LOW STOCK - REORDER";
    else if (currentBalance <= 30) supplyStatus = "RUNNING LOW";
    
    // Column 5: Advanced Moving Threshold Epidemiology Logic (Velocity Check)
    let epiStatus = "ENDEMIC BASELINE (NORMAL)";
    
    // Check geographic cluster concentration
    let maxCasesInSingleLGA = 0;
    let hotspotLGA = "";
    if (lgaDistribution[profile]) {
      for (let lga in lgaDistribution[profile]) {
        if (lgaDistribution[profile][lga] > maxCasesInSingleLGA) {
          maxCasesInSingleLGA = lgaDistribution[profile][lga];
          hotspotLGA = lga;
        }
      }
    }
    
    // Typhoid Specific Cluster Check (NCDC Rule: >= 6 cases in a cluster = Epidemic)
    if (profile.includes("WIDAL") && currentWeekCount >= 6) {
      epiStatus = `🚨 TYPHOID OUTBREAK FLAGGED (${currentWeekCount} Cases in Cluster)`;
    } 
    // Generic Rolling Baseline Velocity Check (If current week exceeds historical baseline by > 50%)
    else if (currentWeekCount > (HISTORICAL_WEEKLY_BASELINE_AVG * 1.5)) {
      epiStatus = `⚠️ ELEVATED INCIDENCE VELOCITY (+${Math.round(((currentWeekCount - HISTORICAL_WEEKLY_BASELINE_AVG)/HISTORICAL_WEEKLY_BASELINE_AVG)*100)}% vs Baseline)`;
      if (maxCasesInSingleLGA >= 5) {
        epiStatus = `🚨 REGIONAL OUTBREAK: Hotspot localized to ${hotspotLGA}`;
      }
    } else if (currentWeekCount > HISTORICAL_WEEKLY_BASELINE_AVG) {
      epiStatus = "MODERATE INCIDENCE FLUCTUATION";
    }
    
    // Populate layout matrix arrays
    analyticsSheet.getRange(outputRow, 1).setValue(profile);
    analyticsSheet.getRange(outputRow, 2).setValue(currentWeekCount);
    analyticsSheet.getRange(outputRow, 3).setValue(initialStock === 0 ? "N/A" : currentBalance);
    analyticsSheet.getRange(outputRow, 4).setValue(supplyStatus);
    analyticsSheet.getRange(outputRow, 5).setValue(epiStatus);
    
    // UI Styling for Supplies
    let sCell = analyticsSheet.getRange(outputRow, 4);
    if (currentBalance <= 10 || initialStock === 0) sCell.setFontColor("#b91c1c").setFontWeight("bold");
    else if (currentBalance <= 30) sCell.setFontColor("#b45309").setFontWeight("bold");
    else sCell.setFontColor("#047857");
    
    // UI Styling for Public Health Alerts
    let eCell = analyticsSheet.getRange(outputRow, 5);
    if (epiStatus.includes("🚨")) {
      eCell.setBackground("#fee2e2").setFontColor("#991b1b").setFontWeight("bold");
    } else if (epiStatus.includes("⚠️") || epiStatus.includes("MODERATE")) {
      eCell.setFontColor("#b45309").setFontWeight("bold");
    } else {
      eCell.setFontColor("#4b5563");
    }
    
    if (!inventoryMap[profile]) {
      analyticsSheet.getRange(outputRow, 7).setValue(profile);
      analyticsSheet.getRange(outputRow, 8).setValue(0);
    }
    
    outputRow++;
  }
  SpreadsheetApp.flush();
}
