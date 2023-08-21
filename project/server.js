const express = require('express');
const axios = require('axios'); //axios library to fetch the content of a webpage, and cheerio to parse and extract data from the fetched webpage content.
const cheerio = require('cheerio');
const app = express();
const ejs = require('ejs')
const bodyParser = require('body-parser')

const cors = require('cors'); 
const mysql = require('mysql2/promise');
const fs = require('fs'); 
const csvParser = require('csv-parser');

const port = process.env.PORT || 3000
app.use(cors());
app.use(express.json());
require('dotenv').config()
app.set('view engine','ejs')
app.set('views','./views')
app.use(bodyParser.urlencoded({ extended: false }))
app.use(express.static('public'))  

// let courseNames;
// let courseInfo;
// let courseNamesUSGA;


// // utility functions to normalize course names and check if two courses might be the same.
// function normalizeName(name) {
//     if (!name || typeof name !== 'string') {
//         return '';  // or handle it in another appropriate way
//     }

//     name = name.toLowerCase().trim(); // convert to lowercase 
//     name = name.replace(/[^a-z0-9\s]/g, ""); // remove non-alphanumeric characters
//     name = name.replace(/\s+/g, " "); // convert multiple spaces to single space
//     const removeWords = ["the", "course", "club", "country"];
//     name = name.split(' ').filter(word => !removeWords.includes(word)).join(' '); // remove certain words
//     return name;
// }

// function courseMatch(name1, name2) {
//     // Normalize both names
//     const normalized1 = normalizeName(name1);
//     const normalized2 = normalizeName(name2);

//     // Substring check
//     if(normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
//         return true;
//     }

//     // Similarity check
//     const similarity = stringSimilarity.compareTwoStrings(normalized1, normalized2);
//     if(similarity > 0.8) {
//         return true;
//     }

//     // More advanced checks can be added here...

//     return false;
// }



// function getSlopeAndRatingFromCrawledData(courseNames, courseNamesUSGA) {
//     const courseData = courseNamesUSGA.find(data => {
//         const isMatch = courseMatch(data.name, courseNames);
//         console.log(`Checking match for "${data.name}" against "${courseNames}": ${isMatch}`);
//         return isMatch;
//     });
//     return courseData ? { slope: courseData.slope, rating: courseData.rating } : null;
// }

//find method loops through each item (referred to as data in the callback function) in the crawledData array 
//and executes the given callback function. 
//The first item for which the callback function returns true will be returned by the find method.

//Inside the callback function, we're calling the utility function courseMatch(data.name, courseName). 
//This function checks if the current data.name from the crawledData array matches the provided courseName. 
//If a match is found, courseData will hold that matched object. 
//If no matches are found, courseData will be undefined.


// Database connection configuration * move this to environment variables later
const db = {
    database: "golfcourse_data",
    host: "127.0.0.1",
    user: "root",
    password: "thfdk69",
};

// Create a pool to manage connections to the database
const pool = mysql.createPool(db);

//checks if a golf course already exists in the database.
async function golfCourseExists(courseName) {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query("SELECT 1 FROM golf_courses WHERE course_name = ?", [courseName]);
        return rows.length > 0; // returns true if course exists, otherwise false
    } catch (error) {
        console.error("Failed to check if golf course exists:", error);
        return false;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

//inserts a new golf course into the database. It first checks if the course already exists, and if not, 
//it inserts the course ratings and slope ratings into the database.
async function insertGolfCourseData(courseInfo) {
    if (!courseInfo || !courseInfo.Golfcourse_Name) {
        console.error("Invalid course info provided.");
        return;
    }

    // Check if golf course already exists
    const exists = await golfCourseExists(courseInfo.Golfcourse_Name);
    if (exists) {
        console.log(`Golf course "${courseInfo.Golfcourse_Name}" already exists. Skipping insertion.`);
        return;
    }

    let connection;
    try {
        // Establish a database connection from the pool
        connection = await pool.getConnection();

        // Begin a transaction
        await connection.beginTransaction();
        
        // Insert the golf course information into the database
        for (let i = 0; i < courseInfo.Course_Rating.length; i++) {
            const teeName = courseInfo.Course_Rating[i].teeName;
            const rating = courseInfo.Course_Rating[i].rating;
            const slopeRating = courseInfo.Course_SlopeRating[i].slopeRating;

            await connection.query(
                "INSERT INTO golf_courses (course_name, rating, slope_rating) VALUES (?, ?, ?)",
                [courseInfo.Golfcourse_Name, `${teeName} ${rating}`, `${teeName} ${slopeRating}`]
            );
        }

        // Commit the transaction
        await connection.commit();
        console.log(`Data for "${courseInfo.Golfcourse_Name}" inserted successfully into db`);  
        
    } catch (error) {
        // Rollback the transaction on error
        if (connection) {
            await connection.rollback();
        }
        console.error("Failed to insert data into the database:", error);
    } finally {
        // Release the database connection
        if (connection) {
            connection.release();
        }
    }
}


// // Function to insert golf course data into the database
// async function insertGolfCourseData(courseInfo) {
//     let connection;
//     try {
//         // Establish a database connection from the pool
//         connection = await pool.getConnection();

//         // Begin a transaction
//         await connection.beginTransaction();
//             // Insert the golf course information into the database
//             for (let i = 0; i < courseInfo.Course_Rating.length; i++) {
//                 const teeName = courseInfo.Course_Rating[i].teeName;
//                 const rating = courseInfo.Course_Rating[i].rating;
//                 const slopeRating = courseInfo.Course_SlopeRating[i].slopeRating;

//                 await connection.query(
//                     "INSERT INTO golf_courses (course_name, rating, slope_rating) VALUES (?, ?, ?)",
//                     [courseInfo.Golfcourse_Name, `${teeName} ${rating}`, `${teeName} ${slopeRating}`]
//                 );
//             }
//             // Commit the transaction
//             await connection.commit();
//             console.log("Data inserted successfully into db");  
//             existingCourseNames.add(courseInfo.Golfcourse_Name);
        
//     } catch (error) {
//         // Rollback the transaction on error
//         if (connection) {
//             await connection.rollback();
//         }
//         console.error("Failed to insert data into the database:", error);
//     } finally {
//         // Release the database connection
//         if (connection) {
//             connection.release();
//         }
//     }
// }
let existingCourseNames = new Set();

// Fetch all existing course names and store in the Set
async function fetchExistingCourses() {
    try {
        const results = await pool.query("SELECT course_name FROM golf_courses");
        for (let row of results) {
            existingCourseNames.add(row.course_name);
        }
        console.log("Course inserting is done.");
    } catch (error) {
        console.error("Failed to fetch existing courses:", error);
    }
}



// fetch the HTML content from url 
const getHTML = async (keyword) => { 
    try {
        const html = await axios.get(`https://ncrdb.usga.org/courseTeeInfo.aspx?CourseID=${keyword}`);
        return html.data;
    } catch (e) {
        console.error("Error making Axios request:", e.response.status, e.response.statusText);
        return null;
    }
};



// Function to get golf course info from the USGA website 
async function getGolfCourseInfo(keyword) {
    const html = await getHTML(keyword);
    if (!html) {
        console.error("Failed to fetch HTML data from the website.");
        return null;
    }
    try{
        const $ = cheerio.load(html);

        const golfCourseName = $("#gvCourseTees > tbody > tr:nth-child(2) > td:nth-child(1)").text().trim();

        // Extract the tee names, course ratings, and slope ratings separately
        const teeNames = [];
        const courseRatings = [];
        const slopeRatings = [];
        for (let i = 2; i <= 26; i++) {
            const teeName = $(`#gvTee > tbody > tr:nth-child(${i}) > td:nth-child(1)`).text().trim();
            const courseRating = parseFloat($(`#gvTee tr:nth-child(${i}) td:nth-child(4)`).text().trim());
            const slopeRating = parseFloat($(`#gvTee > tbody > tr:nth-child(${i}) > td.GVPadding.dtPadding.ratingsStyleItems`).text().trim());

            // Handle NaN values or parsing errors
        if (isNaN(courseRating)) {
            courseRatings.push(0); // Use a default value of 0 for invalid ratings
        } else {
            courseRatings.push(courseRating);
        }

        if (isNaN(slopeRating)) {
            slopeRatings.push(0); // Use a default value of 0 for invalid ratings
        } else {
            slopeRatings.push(slopeRating);
        }
        teeNames.push(teeName);
        }
        // Create an array of objects with the extracted information
        const courseInfo = {
            Golfcourse_Name: golfCourseName,
            Course_Rating: teeNames.map((teeName, index) => ({ teeName, rating: courseRatings[index] })),
            Course_SlopeRating: teeNames.map((teeName, index) => ({ teeName, slopeRating: slopeRatings[index] })),
        };
        // const courseNamesUSGA = courseInfo.Golfcourse_Name;
        // console.log('All USGA course names:', courseNamesUSGA);
        return courseInfo;

    } catch (error) {
        console.error("Error processing HTML data for keyword:", keyword, error);
        return null;
    }    
};

const golfCourseKeywords = [];
let lineCount = 0; // variable to track the current line number
    
fs.createReadStream('courseCode.csv')
    .pipe(csvParser())
    .on('data', (row) => {
        lineCount++;
        if (lineCount < 352) return; // * Skip lines before 170 데이터 추가할때!!

        const keyword = row.Keyword;
        // Check if course does not exist in our Set
        if (!existingCourseNames.has(keyword)) {
            golfCourseKeywords.push(keyword);
        }
    })
    .on('end', async () => {  
        async function main() {
            for (const keyword of golfCourseKeywords) {
                try {
                    await new Promise(resolve => setTimeout(resolve, 2000)); // delay to prevent rate limiting or overloading
        
                    // Fetch course data using the keyword
                    const courseInfo = await getGolfCourseInfo(keyword);
                    
                    if (!courseInfo) {
                        console.log(`No data returned for keyword: ${keyword}`);
                        continue; // skip if no course info returned
                    }

                    // Try to insert the data
                    try {
                        await insertGolfCourseData(courseInfo);
                    } catch (insertError) {
                        console.error(`Error inserting data for keyword "${keyword}":`, insertError);
                    }
                    
                } catch (error) {
                    console.error(`Error processing keyword "${keyword}":`, error);
                }
            }
        }
        main();   
    });



//Routing
//API key

const golfFinderApiKey = '234b53b3ccmshb82c7579628c603p1da094jsn811e7646403a'
const apiKey = '40b6c60e-5176-4733-b670-0b3e539e1ae3';
const courseId = '141520658891108829';
const geocodingApiKey = 'AIzaSyDxp3pJu2sISavqnPqunkK5FgaTvpqkKdA';
app.get('/search', async (req, res) => {
    try {
        const { lat, lng } = await getCoordinatesFromAddress(req.query.location);
        const courseNames = await getNearbyGolfCourses(lat, lng);

        // Fetch additional details from your DB
        const detailedCourseInfo = await fetchGolfCourseDetails(courseNames);

        console.log(detailedCourseInfo);

        res.json(detailedCourseInfo);
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).send('Error fetching data.');
    }
});

async function getCoordinatesFromAddress(location) {
    const geocodingUrl = 'https://maps.googleapis.com/maps/api/geocode/json';
    const response = await axios.get(geocodingUrl, { params: { address: location, key: geocodingApiKey } });
    const results = response.data.results;
    
    if (!results || results.length === 0) {
        throw new Error('Location not found.');
    }

    return results[0].geometry.location;
}

async function getNearbyGolfCourses(lat, lng) {
    const golfFinderUrl = 'https://golf-course-finder.p.rapidapi.com/courses';
    const response = await axios.get(golfFinderUrl, {
        params: { lat, lng, radius: 5 },
        headers: {
            'X-RapidAPI-Key': golfFinderApiKey,
            'X-RapidAPI-Host': 'golf-course-finder.p.rapidapi.com'
        },
    });

    const courses = response.data.courses || [];
    const courseNames = courses.map(course => course.name);
    return courseNames;
    console.log('Fetched course names from Golf Finder API:', courseNames);
}

async function fetchGolfCourseDetails(courseNames) {
    try {
        // SQL query to fetch details of golf courses that match with courseNames
        const query = `
            SELECT 
                a.api_course_id,
                a.course_id,
                m.api_course_name,
                c.course_name,
                c.rating,
                c.slope_rating
            FROM 
                api_to_golf_courses a
            JOIN 
                golf_course_mappings m ON a.api_course_id = m.api_course_id
            JOIN 
                golf_courses c ON a.course_id = c.course_id
            WHERE 
                m.api_course_name IN (?);
        `;
        const sanitizedCourseNames = courseNames.map(name => name.trim().toLowerCase());
        console.log('Sanitized course names:', sanitizedCourseNames);
        const [results] = await pool.query(query, [sanitizedCourseNames]);
        // console.log('Query results:', results);
        // const [results] = await pool.query(query, [courseNames]);


        return results;
    } catch (error) {
        console.error("Error fetching golf course details:", error);
        throw error;
    }
}




// async function fetchGolfCourseDetails(courseNames) {
//     try {
//         const [results] = await pool.query(`
//             SELECT 
//                 gc.course_name,
//                 gc.rating,
//                 gc.slope_rating
//             FROM 
//                 golf_courses gc
//             JOIN 
//                 api_to_golf_courses atgc ON gc.course_id = atgc.course_id
//             JOIN 
//                 golf_course_mappings gcm ON atgc.api_course_id = gcm.api_course_id
//             WHERE 
//                 gcm.api_course_name IN (?);
//         `, [courseNames]);

//         return results;
//     } catch (error) {
//         console.error("Error fetching golf course details:", error);
//         throw error;
//     }
// }

// Add an interceptor to catch and log errors globally
axios.interceptors.response.use(
    (response) => response,
    (error) => {
        console.error('Error fetching data:', error);
        return Promise.reject(error);
    }
);



app.get('/', function (req, res) {
    res.render('index')  // ./views/index.ejs 불러와서 출력
})

app.get('/ranking', function (req, res) {
    res.render('ranking')  
})

app.get('/home', function (req, res) {
    res.render('home')  
})

app.get('/contact', function (req, res) {
    res.render('contact') 
})

app.get('/result', function (req, res) {
    res.render('result') 
})

app.get('/SouthernCali', function (req, res) {
    res.render('SouthernCali') 
})

app.get('/NorthernCali', function (req, res) {
    res.render('NorthernCali') 
})

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


app.listen(port)

